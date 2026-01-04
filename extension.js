import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

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
  // Minimal Pango markup escaping
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

  // Dim the parent part (and the slash) while keeping the project name normal
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

  return new Gio.ThemedIcon({ name: 'applications-development-symbolic' });
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
    p.init(null);
  } catch (e) {
    log(`[Code Launcher] Failed to launch: ${e}`);
    Main.notifyError('Code Launcher', `Failed to launch ${cmd}: ${e}`);
  }
}

function _scanForIdeaProjects(rootPath) {
  const root = Gio.File.new_for_path(rootPath);
  const projects = [];
  const stack = [{ file: root, depth: 0 }];

  while (stack.length > 0) {
    const { file, depth } = stack.pop();
    if (depth > SCAN_LIMIT_DEPTH) continue;
    if (projects.length >= SCAN_LIMIT_PROJECTS) break;

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

      if (name === 'node_modules' || name === '.git' || name === '.cache')
        continue;

      const child = file.get_child(name);

      const ideaDir = child.get_child('.idea');
      try {
        if (ideaDir.query_exists(null)) {
          projects.push(child.get_path());
          continue;
        }
      } catch { }

      stack.push({ file: child, depth: depth + 1 });
    }

    try { enumerator.close(null); } catch { }
  }

  // Sort by parent/project (case-insensitive)
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

      // const Me = Extension.lookupByURL(import.meta.url);
      // this._panelIcon = new St.Icon({
      //   gicon: new Gio.FileIcon({ file: Me.dir.get_child('icons').get_child('code-launcher-symbolic.svg') }),
      //   style_class: 'system-status-icon',
      // });

      // this.add_child(this._panelIcon);


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

        // Defer focus to the next main loop tick so the entry is realized
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          try {
            this._searchEntry.grab_key_focus();
            // Select all existing text to allow quick overwrite
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

        // Re-open after GNOME closes it (next tick), then focus search.
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

      this._settingsChangedId = this._settings.connect('changed', () => {
        this._allProjects = [];
        this._hasScannedOnce = false;
        this._searchText = '';
        this._searchEntry.set_text('');
        this._showNeedsRescan();
      });

      this._refreshNow(false);
    }

    destroy() {
      if (this._settingsChangedId) {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
      }
      super.destroy();
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

      if (this._allProjects.length === 0) {
        this._showSingleDisabledLine('No .idea projects found');
        return;
      }

      const q = this._searchText;
      const filtered = q
        ? this._allProjects.filter(p => {
          const label = _getProjectDisplayLabel(p).toLowerCase();
          return label.includes(q) || p.toLowerCase().includes(q);
        })
        : this._allProjects;

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

        // Apply markup to dim the parent part
        try {
          menuItem.label.clutter_text.set_markup(markupLabel);
        } catch (e) {
          // Fallback to plain text if markup fails
          menuItem.label.set_text(plainLabel);
          log(`[Code Launcher] Failed to set markup label: ${e}`);
        }

        menuItem.connect('activate', () => _launchProject(projectPath, ideKey));
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

    const place = () => {
      const index = Math.max(0, this._settings.get_int('panel-index') || 0);

      if (this._indicator) {
        this._indicator.destroy();
        this._indicator = null;
      }

      this._indicator = new CodeLauncherIndicator(this);

      // Always on the right
      Main.panel.addToStatusArea(this.uuid, this._indicator, index, 'right');
    };

    place();

    this._panelIndexChangedId = this._settings.connect('changed::panel-index', place);
  }

  disable() {
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
