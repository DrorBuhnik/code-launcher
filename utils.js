import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const SCAN_LIMIT_PROJECTS = 5000;
export const SCAN_LIMIT_DEPTH = 50;

export const TOOLBOX_SCRIPTS_DIR = GLib.build_filenamev([
  GLib.get_home_dir(),
  '.local', 'share', 'JetBrains', 'Toolbox', 'scripts',
]);

export const TOOLBOX_APPS_DIR = GLib.build_filenamev([
  GLib.get_home_dir(),
  '.local', 'share', 'JetBrains', 'Toolbox', 'apps',
]);

// Your Toolbox layout (directory names under TOOLBOX_APPS_DIR)
export const TOOLBOX_APP_DIR = {
  webstorm: 'webstorm',
  goland: 'goland',
  rustrover: 'rustrover',
  pycharm: 'pycharm',
  intellij: 'intellij-idea',
};

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

export function findInPath(cmd) {
  return GLib.find_program_in_path(cmd);
}

export function findToolboxScript(cmd) {
  const p = joinPath(TOOLBOX_SCRIPTS_DIR, cmd);
  return fileExists(p) ? p : null;
}

export function ideCmdForKey(ideKey) {
  switch (ideKey) {
    case 'goland': return 'goland';
    case 'rustrover': return 'rustrover';
    case 'pycharm': return 'pycharm';
    case 'intellij': return 'idea';
    case 'webstorm':
    default:
      return 'webstorm';
  }
}

export function pickIdeForProject(projectPath) {
  // Explicit marker
  if (fileExists(joinPath(projectPath, '.idea', '.name')))
    return 'intellij';

  // Use markers
  for (const [ide, files] of Object.entries(MARKERS)) {
    for (const f of files) {
      if (fileExists(joinPath(projectPath, f)))
        return ide;
    }
  }
  return 'webstorm';
}

export function getProjectParts(projectPath) {
  const projectName = GLib.path_get_basename(projectPath);
  const parentPath = GLib.path_get_dirname(projectPath);
  const parentName = GLib.path_get_basename(parentPath);
  return { parentName, projectName };
}

export function getProjectDisplayLabel(projectPath) {
  const { parentName, projectName } = getProjectParts(projectPath);
  return `${parentName}/${projectName}`;
}

export function escapeMarkup(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function getProjectDisplayMarkup(projectPath) {
  const { parentName, projectName } = getProjectParts(projectPath);
  return `<span size="small" alpha="70%">${escapeMarkup(parentName)}/</span>${escapeMarkup(projectName)}`;
}

export function getToolboxIdeIcon(ideKey) {
  // Prefer Toolbox's product icons when present.
  const appDir = TOOLBOX_APP_DIR[ideKey] ?? TOOLBOX_APP_DIR.webstorm;
  const baseName = ideKey === 'intellij' ? 'idea' : ideKey;

  const pngPath = joinPath(TOOLBOX_APPS_DIR, appDir, 'bin', `${baseName}.png`);
  if (fileExists(pngPath))
    return new Gio.FileIcon({ file: Gio.File.new_for_path(pngPath) });

  const svgPath = joinPath(TOOLBOX_APPS_DIR, appDir, 'bin', `${baseName}.svg`);
  if (fileExists(svgPath))
    return new Gio.FileIcon({ file: Gio.File.new_for_path(svgPath) });

  return null;
}

export function getMenuIconForProject(projectPath, ideKey) {
  const customIconPath = joinPath(projectPath, '.idea', 'icon.png');
  if (fileExists(customIconPath))
    return new Gio.FileIcon({ file: Gio.File.new_for_path(customIconPath) });

  return getToolboxIdeIcon(ideKey);
}

export function shSingleQuote(s) {
  // Safe single-quote escaping for /bin/sh -lc
  return `'${String(s).replaceAll("'", `'"'"'`)}'`;
}

export function normalizeIgnoredProjects(setOrArray) {
  const arr = [...setOrArray].map(s => String(s).trim()).filter(Boolean);
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
  // A project root is any directory containing one of these markers
  const markers = ['.idea', '.git', '.hg', '.svn'];
  for (const marker of markers) {
    try {
      if (dirFile.get_child(marker).query_exists(null))
        return true;
    } catch {
      // ignore permission/io errors
    }
  }
  return false;
}
