import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Keep this in sync with extension.js
const SCAN_LIMIT_PROJECTS = 5000;
const SCAN_LIMIT_DEPTH = 50;

function _join(...parts) {
  return GLib.build_filenamev(parts);
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

  return [...projectsSet].sort((a, b) => a.localeCompare(b));
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

export default class CodeLauncherPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    // Local cache so we can show a real list of projects (and avoid rescanning constantly)
    let scannedProjects = [];

    const page = new Adw.PreferencesPage({
      title: 'Code Launcher',
      icon_name: 'applications-development-symbolic',
    });

    // ---- Scanning group ----
    const scanGroup = new Adw.PreferencesGroup({
      title: 'Scanning',
      description: 'Choose the directory to scan for .idea projects.',
    });

    const dirRow = new Adw.ActionRow({
      title: 'Scan directory',
      subtitle: 'Root folder to scan recursively for .idea folders',
    });

    const chooseBtn = new Gtk.Button({ label: 'Choose…' });
    dirRow.add_suffix(chooseBtn);
    dirRow.activatable_widget = chooseBtn;

    const currentDirLabel = new Gtk.Label({
      xalign: 1,
      selectable: true,
      ellipsize: 3,
    });

    const updateDirLabel = () => {
      const v = settings.get_string('scan-directory');
      currentDirLabel.set_text(v && v.trim() !== '' ? v : '(not set)');
    };
    updateDirLabel();

    dirRow.add_suffix(currentDirLabel);

    chooseBtn.connect('clicked', () => {
      const dialog = new Gtk.FileDialog();
      dialog.select_folder(window, null, (d, res) => {
        try {
          const file = d.select_folder_finish(res);
          if (file) settings.set_string('scan-directory', file.get_path() ?? '');
        } catch (e) {
          // cancel is normal
          log(`[Code Launcher] select_folder failed: ${e}`);
        }
      });
    });

    scanGroup.add(dirRow);
    page.add(scanGroup);

    // ---- Panel group ----
    const panelGroup = new Adw.PreferencesGroup({
      title: 'Panel',
      description: 'Control the order of the indicator on the right side of the top bar.',
    });

    const indexRow = new Adw.SpinRow({
      title: 'Order (index)',
      subtitle: '0 = first in the right section. Increase to move rightward.',
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 50,
        step_increment: 1,
        page_increment: 5,
        value: 0,
      }),
    });

    // ✅ Bulletproof: bind directly to GSettings
    settings.bind('panel-index', indexRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    panelGroup.add(indexRow);
    page.add(panelGroup);

    // ---- Projects visibility group ----
    const projectsGroup = new Adw.PreferencesGroup({
      title: 'Detected projects',
      description: 'Toggle projects to show or hide them from the top-bar popup.',
    });

    const toolbarRow = new Adw.ActionRow({
      title: 'Controls',
      subtitle: 'Scan and manage which projects appear in the popup.',
    });

    const rescanBtn = new Gtk.Button({
      label: 'Rescan',
      valign: Gtk.Align.CENTER,
    });
    toolbarRow.add_suffix(rescanBtn);
    toolbarRow.activatable_widget = rescanBtn;
    projectsGroup.add(toolbarRow);

    // We'll add project rows directly into the PreferencesGroup (rather than a ListBox)
    // so ExpanderRow works naturally.
    const projectRows = [];

    const setIgnored = (set) => {
      settings.set_strv('ignored-projects', [...set]);
    };

    const getIgnored = () => new Set((settings.get_strv('ignored-projects') ?? [])
      .map(s => String(s).trim())
      .filter(Boolean));

    const clearProjectsList = () => {
      for (const row of projectRows)
        projectsGroup.remove(row);
      projectRows.length = 0;
    };

    const rebuildProjectsList = () => {
      clearProjectsList();

      const rootPath = settings.get_string('scan-directory');
      if (!rootPath || rootPath.trim() === '') {
        const empty = new Adw.ActionRow({
          title: 'Set a scan directory first',
          subtitle: 'Go to “Scanning” above and choose a folder.',
        });
        empty.set_sensitive(false);
        projectsGroup.add(empty);
        projectRows.push(empty);
        return;
      }

      if (scannedProjects.length === 0) {
        const empty = new Adw.ActionRow({
          title: 'No projects detected yet',
          subtitle: 'Click “Rescan” to scan for projects.',
        });
        empty.set_sensitive(false);
        projectsGroup.add(empty);
        projectRows.push(empty);
        return;
      }

      // Sort by friendly label
      const sorted = [...scannedProjects].sort((a, b) =>
        _getProjectDisplayLabel(a).toLowerCase().localeCompare(_getProjectDisplayLabel(b).toLowerCase()));

      const ignored = getIgnored();
      for (const p of sorted) {
        const label = _getProjectDisplayLabel(p);
        const row = new Adw.ActionRow({
          title: label,
          subtitle: p,
          selectable: false,
        });
        // row.set_subtitle_lines(2);
        // row.subtitle.add_css_class('dim-label');
        // row.subtitle.add_css_class('monospace');
        row.set_tooltip_text(p);

        const toggle = new Gtk.Switch({
          valign: Gtk.Align.CENTER,
        });

        toggle.set_active(!ignored.has(p));

        toggle.connect('notify::active', () => {
          this._setProjectHidden(p, !toggle.active);
        });

        row.add_suffix(toggle);
        row.set_activatable_widget(toggle);

        projectsGroup.add(row);
        projectRows.push(row);
      }
    };


    const doRescan = () => {
      const rootPath = settings.get_string('scan-directory');
      if (!rootPath || rootPath.trim() === '' || !GLib.file_test(rootPath, GLib.FileTest.IS_DIR)) {
        scannedProjects = [];
        rebuildProjectsList();
        return;
      }

      // Quick visual feedback
      toolbarRow.set_subtitle('Scanning…');

      try {
        scannedProjects = _scanForIdeaProjects(rootPath);
      } catch (e) {
        log(`[Code Launcher] prefs rescan failed: ${e}`);
        scannedProjects = [];
      }

      toolbarRow.set_subtitle(`${scannedProjects.length} detected. Use toggles to show/hide in popup.`);
      rebuildProjectsList();
    };

    rescanBtn.connect('clicked', doRescan);

    // Initial build: scan once so Settings matches the popup
    doRescan();
    page.add(projectsGroup);

    window.add(page);

    settings.connect('changed::scan-directory', updateDirLabel);
    settings.connect('changed::scan-directory', () => {
      // Directory changed: rescan so the list stays in sync with the popup.
      doRescan();
    });
    settings.connect('changed::ignored-projects', rebuildProjectsList);
  }
}