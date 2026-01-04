import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
  SCAN_LIMIT_PROJECTS,
  SCAN_LIMIT_DEPTH,
  getProjectDisplayLabel,
  isSkippableDirName,
  isRelevantDir,
} from './utils.js';

function _promisifyEnumerateChildren(file, cancellable) {
  return new Promise((resolve, reject) => {
    file.enumerate_children_async(
      'standard::name,standard::type',
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      GLib.PRIORITY_DEFAULT,
      cancellable,
      (f, res) => {
        try {
          resolve(f.enumerate_children_finish(res));
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

function _promisifyNextFiles(enumerator, count, cancellable) {
  return new Promise((resolve, reject) => {
    enumerator.next_files_async(
      count,
      GLib.PRIORITY_DEFAULT,
      cancellable,
      (e, res) => {
        try {
          resolve(e.next_files_finish(res));
        } catch (err) {
          reject(err);
        }
      }
    );
  });
}

function _closeQuietly(obj) {
  try {
    obj?.close?.(null);
  } catch {
    // ignore
  }
}

export function createCancellable() {
  return new Gio.Cancellable();
}

/**
 * Async filesystem scan that avoids blocking GNOME Shell.
 *
 * @param {string} rootPath
 * @param {object} opts
 * @param {number} [opts.limitProjects]
 * @param {number} [opts.limitDepth]
 * @param {Gio.Cancellable} [opts.cancellable]
 * @param {(count:number)=>void} [opts.onProgress] called when project count increases
 * @returns {Promise<string[]>} sorted project paths
 */
export async function scanForIdeaProjectsAsync(rootPath, opts = {}) {
  const limitProjects = opts.limitProjects ?? SCAN_LIMIT_PROJECTS;
  const limitDepth = opts.limitDepth ?? SCAN_LIMIT_DEPTH;
  const cancellable = opts.cancellable ?? null;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const root = Gio.File.new_for_path(rootPath);

  const projectsSet = new Set();
  const stack = [{ file: root, depth: 0 }];

  while (stack.length > 0 && projectsSet.size < limitProjects) {
    if (cancellable?.is_cancelled())
      break;

    const { file, depth } = stack.pop();
    if (depth > limitDepth)
      continue;

    let enumerator = null;
    try {
      enumerator = await _promisifyEnumerateChildren(file, cancellable);
    } catch {
      continue;
    }

    try {
      while (true) {
        if (cancellable?.is_cancelled())
          break;

        const infos = await _promisifyNextFiles(enumerator, 64, cancellable);
        if (!infos || infos.length === 0)
          break;

        for (const info of infos) {
          const name = info.get_name();
          const type = info.get_file_type();
          if (type !== Gio.FileType.DIRECTORY)
            continue;
          if (isSkippableDirName(name))
            continue;

          const child = file.get_child(name);

          try {
            if (isRelevantDir(child)) {
              const p = child.get_path();
              if (p) {
                const before = projectsSet.size;
                projectsSet.add(p);
                if (onProgress && projectsSet.size !== before)
                  onProgress(projectsSet.size);
              }
              continue;
            }
          } catch {
            // ignore
          }

          stack.push({ file: child, depth: depth + 1 });
        }
      }
    } catch {
      // ignore
    } finally {
      _closeQuietly(enumerator);
    }
  }

  const projects = [...projectsSet];
  projects.sort((a, b) => {
    const ka = getProjectDisplayLabel(a).toLowerCase();
    const kb = getProjectDisplayLabel(b).toLowerCase();
    return ka.localeCompare(kb);
  });
  return projects;
}
