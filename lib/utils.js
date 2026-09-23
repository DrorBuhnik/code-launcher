import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GioUnix from "gi://GioUnix";

export const SCAN_LIMIT_PROJECTS = 5000;
export const SCAN_LIMIT_DEPTH = 50;

// Heuristics for picking an IDE by project contents
export const MARKERS = {
  webstorm: [
    'package.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'tsconfig.json',
    'vite.config.js',
    'vite.config.ts',
    'next.config.js',
    'deno.json',
    'bun.lockb',
    'bunfig.toml',
    'extension.js'
  ],
  goland: ['go.mod', 'go.work'],
  rustrover: ['Cargo.toml', 'rust-toolchain', 'rust-toolchain.toml'],
  pycharm: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'poetry.lock'],
};

export function joinPath(...parts) {
  return GLib.build_filenamev(parts);
}

export function fileExists(path) {
  try {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
  } catch {
    return false;
  }
}

export function pickIdeForProject(projectPath) {
  for (const [ide, markerFiles] of Object.entries(MARKERS)) {
    for (const f of markerFiles) {
      if (fileExists(joinPath(projectPath, f)))
        return ide;
    }
  }
  return 'intellij';
}

export function getAppInfo(name) {
  return GioUnix.DesktopAppInfo.new((GioUnix.DesktopAppInfo.search(name))[0][0]);
}

export function getProjectParts(projectPath) {
  const projectName = GLib.path_get_basename(projectPath);
  const parentPath = GLib.path_get_dirname(projectPath);
  const parentName = GLib.path_get_basename(parentPath);
  return {parentName, projectName};
}

export function getProjectDisplayLabel(projectPath) {
  const {parentName, projectName} = getProjectParts(projectPath);
  return `${parentName}/${projectName}`;
}

export function getProjectName(projectPath) {
  return GLib.path_get_basename(projectPath);
}

export function escapeMarkup(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// A section groups every project sharing the same parent directory. The full
// parent path is the identity (it survives renames of the scan root's display
// name and never collides), the label is what the popup shows.
export function getSectionKey(projectPath) {
  return GLib.path_get_dirname(projectPath);
}

function stripTrailingSlashes(path) {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export function relativeToRoot(path, rootPath) {
  const root = stripTrailingSlashes((rootPath ?? '').trim());

  if (!root || path === root)
    return '';

  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

const compareLabels = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());

function finalizeNode(node) {
  const children = [...node.children.values()].map(finalizeNode);
  children.sort((a, b) => compareLabels(a.label, b.label));

  const projects = node.projects.sort((a, b) => compareLabels(getProjectName(a), getProjectName(b)));
  const total = projects.length + children.reduce((sum, child) => sum + child.total, 0);

  return {key: node.key, label: node.label, depth: node.depth, children, projects, total};
}

// Mirrors the directory layout below the scan root: one node per path segment,
// so external/github/DrorBuhnik/code-launcher nests three sections deep. The
// root node itself has depth -1 and gets no header — projects sitting directly
// in the scan directory are listed at the top with nothing above them.
export function buildSectionTree(projectPaths, rootPath) {
  const root = stripTrailingSlashes((rootPath ?? '').trim());
  const tree = {key: root, label: '', depth: -1, children: new Map(), projects: []};

  for (const projectPath of projectPaths) {
    let node = tree;

    for (const segment of relativeToRoot(getSectionKey(projectPath), root).split('/')) {
      if (!segment)
        continue;

      let child = node.children.get(segment);
      if (!child) {
        child = {
          key: `${node.key}/${segment}`,
          label: segment,
          depth: node.depth + 1,
          children: new Map(),
          projects: [],
        };
        node.children.set(segment, child);
      }

      node = child;
    }

    node.projects.push(projectPath);
  }

  return finalizeNode(tree);
}

// Prunes every branch that leads to no match, so a search leaves only the
// sections on the way to a hit. Returns null when the whole subtree is empty.
export function filterSectionTree(node, matches) {
  const projects = node.projects.filter(matches);
  const children = node.children
    .map(child => filterSectionTree(child, matches))
    .filter(Boolean);

  const total = projects.length + children.reduce((sum, child) => sum + child.total, 0);
  if (total === 0)
    return null;

  return {...node, children, projects, total};
}

export function getMenuIconForProject(projectPath, ideKey) {
  const customIconPath = joinPath(projectPath, '.idea', 'icon.png');
  if (fileExists(customIconPath))
    return new Gio.FileIcon({file: Gio.File.new_for_path(customIconPath)});

  return getAppInfo(ideKey).get_icon();
}

export function normalizePathList(setOrArray) {
  const arr = [...setOrArray].map(s => s.trim()).filter(Boolean);
  arr.sort();
  return arr;
}

export function isSkippableDirName(name) {
  return (
    name === 'node_modules' ||
    name === '.git' ||
    name === '.hg' ||
    name === '.svn' ||
    name === '.cache'
  );
}

export function isRelevantDir(dirFile) {
  const markers = ['.idea', '.git', '.hg', '.svn'];
  for (const marker of markers) {
    try {
      if (dirFile.get_child(marker).query_exists(null))
        return true;
    } catch {
    }
  }
  return false;
}
