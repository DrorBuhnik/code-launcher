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

export function getProjectDisplayMarkup(projectPath) {
  const {parentName, projectName} = getProjectParts(projectPath);
  // noinspection HtmlUnknownAttribute
  return `<span alpha="70%">${parentName}/</span>${projectName}`;
}

export function getMenuIconForProject(projectPath, ideKey) {
  const customIconPath = joinPath(projectPath, '.idea', 'icon.png');
  if (fileExists(customIconPath))
    return new Gio.FileIcon({file: Gio.File.new_for_path(customIconPath)});

  return getAppInfo(ideKey).get_icon();
}

export function normalizeIgnoredProjects(setOrArray) {
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
