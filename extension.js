import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const SCAN_LIMIT_PROJECTS = 5000;
const SCAN_LIMIT_DEPTH = 50;

// About ~20 items visible. (Tweak if you want)
const LIST_MAX_HEIGHT_PX = 560;

const TOOLBOX_SCRIPTS_DIR = GLib.build_filenamev([
  GLib.get_home_dir(),
  '.local', 'share', 'JetBrains', 'Toolbox', 'scripts',
]);

const TOOLBOX_APPS_DIR = GLib.build_filenamev([
  GLib.get_home_dir(),
  '.local', 'share', 'JetBrains', 'Toolbox', 'apps',
]);

// Your Toolbox layout
const TOOLBOX_APP_DIR = {
  webstorm: 'webstorm',
  goland: 'goland',
  rustrover: 'rustrover',
  pycharm: 'pycharm',
  intellij: 'intellij-idea',
};

// Toolbox script commands
const IDE_COMMANDS = {
  webstorm: 'webstorm',
  goland: 'goland',
  rustrover: 'rustrover',
  pycharm: 'pycharm',
  intellij: 'idea', // fallback
};

// Heuristics to select IDE
const MARKERS = {
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

function _join(...parts) {
  return GLib.build_filenamev(parts);
}

function _fileExists(path) {
  try {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
  } catch {
    return false;
  }
}

function _findInPath(cmd) {
  return GLib.find_program_in_path(cmd);
}

function _findToolboxScript(cmd) {
  const p = _join(TOOLBOX_SCRIPTS_DIR, cmd);
  return _fileExists(p) ? p : null;
}

function _ideCmdForKey(ideKey) {
  return IDE_COMMANDS[ideKey] ?? IDE_COMMANDS.intellij;
}

function _pickIdeForProject(projectPath) {
  for (const [ide, markerFiles] of Object.entries(MARKERS)) {
    for (const f of markerFiles) {
      if (_fileExists(_join(projectPath, f)))
        return ide;
    }
  }
  return 'intellij';
}

function _getProjectParts(projectPath) {
  const projectName = GLib.path_get_basename(projectPath);
  const parentPath = GLib.path_get_dirname(projectPath);
  const parentName = GLib.path_get_basename(parentPath);
  return { parentName, projectName };
}

function _getProjectDisplayLabel(projectPath) {
  const { parentName, projectName } = _getProjectParts(projectPath);
  return `${parentName}/${projectName}`;
}

function _escapeMarkup(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function _getProjectDisplayMarkup(projectPath) {
  const { parentName, projectName } = _getProjectParts(projectPath);
  const p = _escapeMarkup(parentName);
  const n = _escapeMarkup(projectName);
  return `<span alpha="55%">${p}/</span>${n}`;
}

// Toolbox icon lookup using your exact layout; prefer PNG then SVG.
function _getToolboxIdeIcon(ideKey) {
  const appDir = TOOLBOX_APP_DIR[ideKey] ?? TOOLBOX_APP_DIR.intellij;
  const baseName = ideKey === 'intellij' ? 'idea' : ideKey;

  const pngPath = _join(TOOLBOX_APPS_DIR, appDir, 'bin', `${baseName}.png`);
  if (_fileExists(pngPath))
    return new Gio.FileIcon({ file: Gio.File.new_for_path(pngPath) });

  const svgPath = _join(TOOLBOX_APPS_DIR, appDir, 'bin', `${baseName}.svg`);
  if (_fileExists(svgPath))
    return new Gio.FileIcon({ file: Gio.File.new_for_path(svgPath) });

  return null;
}

function _getMenuIconForProject(projectPath, ideKey) {
  const customIconPath = _join(projectPath, '.idea', 'icon.png');
  if (_fileExists(customIconPath)) {
    return new Gio.FileIcon({ file: Gio.File.new_for_path(customIconPath) });
  }

  const toolboxIcon = _getToolboxIdeIcon(ideKey);
  if (toolboxIcon)
    return toolboxIcon;

  // Safer than `new Gio.ThemedIcon({ name: ... })` across setups
  return Gio.ThemedIcon.new('applications-development-symbolic');
}

// Escape for single-quoted POSIX shell string.
function _shSingleQuote(s) {
  return `'${String(s).replaceAll("'", `'\"'\"'`)}'`;
}

function _launchProject(projectPath, ideKey) {
  const cmd = _ideCmdForKey(ideKey);
  const cmdPath = _findInPath(cmd) ?? _findToolboxScript(cmd);

  log(`[Code Launcher] Click -> ideKey=${ideKey} cmd=${cmd} cmdPath=${cmdPath} project=${projectPath}`);

  if (!cmdPath) {
    Main.notifyError(
      'Code Launcher',
      `Could not find "${cmd}" in PATH or "${TOOLBOX_SCRIPTS_DIR}".`
    );
    log(`[Code Launcher] Missing command: ${cmd}`);
    return;
  }

  const shellLine = `${_shSingleQuote(cmdPath)} ${_shSingleQuote(projectPath)}`;
  try {
    const p = new Gio.Subprocess({
      argv: ['/bin/sh', '-lc', shellLine],
      flags: Gio.SubprocessFlags.NONE,
    });
    // In modern GJS, construction already initializes; init() is not needed.
    // Keeping it out avoids odd runtime differences.
    p.spawn_async?.(null);
  } catch (e) {
    log(`[Code Launcher] Failed to launch: ${e}`);
    Main.notifyError('Code Launcher', `Failed to launch ${cmd}: ${e}`);
  }
}

function _scanForIdeaProjects(rootPath) {
  const root = Gio.File.new_for_path(rootPath);

  const projectsSet = new Set();
  const stack = [{ file: root, depth: 0 }];

  const isSkippableDirName = (name) =>
    name === 'node_modules' ||
    name === '.git' ||
    name === '.hg' ||
    name === '.svn' ||
    name === '.cache';

  const isRelevantDir = (dirFile) => {
    const markers = ['.idea', '.git', '.hg', '.svn'];
    for (const marker of markers) {
      try {
        if (dirFile.get_child(marker).query_exists(null))
          return true;
      } catch { }
    }
    return false;
  };

  while (stack.length > 0) {
    const { file, depth } = stack.pop();
    if (depth > SCAN_LIMIT_DEPTH) continue;
    if (projectsSet.size >= SCAN_LIMIT_PROJECTS) break;

    try {
      if (isRelevantDir(file)) {
        const p = file.get_path();
        if (p)
          projectsSet.add(p);
        continue;
      }
    } catch { }

    let enumerator = null;
    try {
      enumerator = file.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null
      );
    } catch {
      continue;
    }

    let info;
    while ((info = enumerator.next_file(null)) !== null) {
      const name = info.get_name();
      const type = info.get_file_type();
      if (type !== Gio.FileType.DIRECTORY) continue;
      if (isSkippableDirName(name)) continue;

      const child = file.get_child(name);

      try {
        if (isRelevantDir(child)) {
          const p = child.get_path();
          if (p)
            projectsSet.add(p);
          continue;
        }
      } catch { }

      stack.push({ file: child, depth: depth + 1 });
    }

    try { enumerator.close(null); } catch { }
  }

  const projects = [...projectsSet];

  projects.sort((a, b) => {
    const ka = _getProjectDisplayLabel(a).toLowerCase();
    const kb = _getProjectDisplayLabel(b).toLowerCase();
    return ka.localeCompare(kb);
  });

  return projects;
}

const CodeLauncherIndicator = GObject.registerClass(
  class CodeLauncherIndicator extends PanelMenu.Button {
    constructor(extension) {
      super(0.0, 'Code Launcher');

      this._extension = extension;
      this._settings = extension.getSettings();

      this._hasScannedOnce = false;
      this._allProjects = [];
      this._searchText = '';

      this._panelIcon = new St.Icon({
        icon_name: 'system-file-manager-symbolic',
        style_class: 'system-status-icon',
      });
      this.add_child(this._panelIcon);

      // Search row
      const searchItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });

      this._searchEntry = new St.Entry({
        hint_text: 'Search projects…',
        can_focus: true,
        x_expand: true,
        style_class: 'popup-menu-entry',
        track_hover: true,
      });

      const searchBox = new St.BoxLayout({ vertical: false, x_expand: true });
      searchBox.add_child(this._searchEntry);
      searchItem.add_child(searchBox);
      this.menu.addMenuItem(searchItem);

      this._searchEntry.clutter_text.connect('text-changed', () => {
        this._searchText = this._searchEntry.get_text().trim().toLowerCase();
        this._rebuildProjectItems();
      });

      // Auto-focus search bar when opening the menu
      this.menu.connect('open-state-changed', (_menu, isOpen) => {
        if (!isOpen)
          return;

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          try {
            this._searchEntry.grab_key_focus();
            this._searchEntry.clutter_text.set_selection(0, -1);
          } catch (e) {
            log(`[Code Launcher] Failed to focus search entry: ${e}`);
          }
          return GLib.SOURCE_REMOVE;
        });
      });

      // Scrollable projects list
      this._projectsSection = new PopupMenu.PopupMenuSection();

      this._scrollView = new St.ScrollView({
        overlay_scrollbars: true,
        style_class: 'code-launcher-scrollview',
      });
      this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
      this._scrollView.style = `max-height: ${LIST_MAX_HEIGHT_PX}px;`;

      this._scrollView.add_child(this._projectsSection.actor);

      const scrollItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });
      scrollItem.add_child(this._scrollView);
      this.menu.addMenuItem(scrollItem);

      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

      const rescanItem = new PopupMenu.PopupMenuItem('Rescan now');
      rescanItem.closeOnActivate = false;
      rescanItem.connect('activate', () => {
        this._refreshNow(true);

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          this.menu.open();
          try {
            this._searchEntry.grab_key_focus();
            this._searchEntry.clutter_text.set_selection(0, -1);
          } catch (e) {
            log(`[Code Launcher] Failed to refocus after rescan: ${e}`);
          }
          return GLib.SOURCE_REMOVE;
        });
      });
      this.menu.addMenuItem(rescanItem);

      const openPrefsItem = new PopupMenu.PopupMenuItem('Settings…');
      openPrefsItem.connect('activate', () => {
        try {
          this._extension.openPreferences();
        } catch (e) {
          log(`[Code Launcher] openPreferences failed: ${e}`);
        }
      });
      this.menu.addMenuItem(openPrefsItem);

      // Only rescan when scan-directory changes
      this._scanDirChangedId = this._settings.connect('changed::scan-directory', () => {
        this._allProjects = [];
        this._hasScannedOnce = false;
        this._searchText = '';
        this._searchEntry.set_text('');
        this._showNeedsRescan();
      });

      // Only refresh list when ignored-projects changes
      this._ignoredChangedId = this._settings.connect('changed::ignored-projects', () => {
        this._rebuildProjectItems();
      });

      this._refreshNow(false);
    }

    destroy() {
      if (this._scanDirChangedId) {
        this._settings.disconnect(this._scanDirChangedId);
        this._scanDirChangedId = 0;
      }
      if (this._ignoredChangedId) {
        this._settings.disconnect(this._ignoredChangedId);
        this._ignoredChangedId = 0;
      }
      super.destroy();
    }

    _getIgnoredSet() {
      try {
        const arr = this._settings.get_strv('ignored-projects') ?? [];
        return new Set(arr.map(s => String(s).trim()).filter(Boolean));
      } catch {
        return new Set();
      }
    }

    _setIgnoredSet(set) {
      try {
        const arr = [...set].map(s => String(s).trim()).filter(Boolean);
        this._settings.set_strv('ignored-projects', arr);
      } catch (e) {
        log(`[Code Launcher] Failed to write ignored-projects (missing schema key?): ${e}`);
      }
    }

    _ignoreProject(projectPath) {
      const set = this._getIgnoredSet();
      set.add(projectPath);
      this._setIgnoredSet(set);
    }

    _showSingleDisabledLine(text) {
      this._projectsSection.removeAll();
      const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
      item.setSensitive(false);
      this._projectsSection.addMenuItem(item);
    }

    _showNeedsRescan() {
      this._showSingleDisabledLine('Directory changed — click “Rescan now”');
    }

    _rebuildProjectItems() {
      this._projectsSection.removeAll();

      const rootPath = this._settings.get_string('scan-directory');
      if (!rootPath || rootPath.trim() === '') {
        this._showSingleDisabledLine('Set a scan directory in Settings…');
        return;
      }

      if (!this._hasScannedOnce) {
        this._showSingleDisabledLine('Click “Rescan now” to scan');
        return;
      }

      const ignored = this._getIgnoredSet();
      const visibleProjects = this._allProjects.filter(p => !ignored.has(p));

      if (visibleProjects.length === 0) {
        this._showSingleDisabledLine('No projects (or all are ignored)');
        return;
      }

      const q = this._searchText;
      const filtered = q
        ? visibleProjects.filter(p => {
          const label = _getProjectDisplayLabel(p).toLowerCase();
          return label.includes(q) || p.toLowerCase().includes(q);
        })
        : visibleProjects;

      if (filtered.length === 0) {
        this._showSingleDisabledLine('No matches');
        return;
      }

      for (const projectPath of filtered) {
        const ideKey = _pickIdeForProject(projectPath);
        const icon = _getMenuIconForProject(projectPath, ideKey);

        const plainLabel = _getProjectDisplayLabel(projectPath);
        const markupLabel = _getProjectDisplayMarkup(projectPath);

        const menuItem = new PopupMenu.PopupImageMenuItem(plainLabel, icon);

        // Style hook for hover CSS
        try {
          menuItem.actor.add_style_class_name('project-item');
          menuItem.actor.x_expand = true;
        } catch { }

        // Apply markup to dim parent part
        try {
          menuItem.label.clutter_text.set_markup(markupLabel);
        } catch (e) {
          menuItem.label.set_text(plainLabel);
          log(`[Code Launcher] Failed to set markup label: ${e}`);
        }

        // Launch on activate
        menuItem.closeOnActivate = true;
        menuItem.connect('activate', () => {
          _launchProject(projectPath, ideKey);
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.menu.close();
            return GLib.SOURCE_REMOVE;
          });
        });

        this._projectsSection.addMenuItem(menuItem);
      }
    }

    _refreshNow(fromManualClick) {
      const rootPath = this._settings.get_string('scan-directory');

      if (!rootPath || rootPath.trim() === '') {
        this._hasScannedOnce = false;
        this._allProjects = [];
        this._rebuildProjectItems();
        return;
      }

      if (!GLib.file_test(rootPath, GLib.FileTest.IS_DIR)) {
        this._hasScannedOnce = false;
        this._allProjects = [];
        this._showSingleDisabledLine(`Not a directory: ${rootPath}`);
        return;
      }

      if (!fromManualClick && this._hasScannedOnce) {
        this._rebuildProjectItems();
        return;
      }

      this._showSingleDisabledLine('Scanning…');

      const projects = _scanForIdeaProjects(rootPath);
      this._allProjects = projects;
      this._hasScannedOnce = true;

      this._rebuildProjectItems();
    }
  });

export default class CodeLauncherExtension extends Extension {
  enable() {
    this._settings = this.getSettings();

    // Load stylesheet.css (GNOME 49+ safe)
    this._stylesheetFile = Gio.File.new_for_path(`${this.path}/stylesheet.css`);
    try {
      St.ThemeContext.get_for_stage(global.stage)
        .get_theme()
        .load_stylesheet(this._stylesheetFile);
    } catch (e) {
      log(`[Code Launcher] Failed to load stylesheet: ${e}`);
    }

    const place = () => {
      const index = Math.max(0, this._settings.get_int('panel-index') || 0);

      if (this._indicator) {
        this._indicator.destroy();
        this._indicator = null;
      }

      this._indicator = new CodeLauncherIndicator(this);
      Main.panel.addToStatusArea(this.uuid, this._indicator, index, 'right');
    };

    place();
    this._panelIndexChangedId = this._settings.connect('changed::panel-index', place);
  }

  disable() {
    if (this._stylesheetFile) {
      try {
        St.ThemeContext.get_for_stage(global.stage)
          .get_theme()
          .unload_stylesheet(this._stylesheetFile);
      } catch (e) {
        log(`[Code Launcher] Failed to unload stylesheet: ${e}`);
      }
      this._stylesheetFile = null;
    }

    if (this._panelIndexChangedId) {
      this._settings.disconnect(this._panelIndexChangedId);
      this._panelIndexChangedId = 0;
    }

    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    this._settings = null;
  }
}
