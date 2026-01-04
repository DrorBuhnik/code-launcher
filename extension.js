import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {getAppInfo, getMenuIconForProject, getProjectDisplayLabel, getProjectDisplayMarkup, pickIdeForProject,} from './lib/utils.js';

import {createCancellable, scanForIdeaProjectsAsync} from './lib/scanner.js';

// About ~20 items visible
const LIST_MAX_HEIGHT_PX = 560;

const CodeLauncherIndicator = GObject.registerClass(
  class CodeLauncherIndicator extends PanelMenu.Button {
    _init(extension) {
      super._init(0.0, 'Code Launcher');

      this._extension = extension;
      this._settings = extension.getSettings();

      this._hasScannedOnce = false;
      this._allProjects = [];
      this._searchText = '';

      this._scanGeneration = 0;
      this._scanCancellable = null;

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

      const searchBox = new St.BoxLayout({vertical: false, x_expand: true});
      searchBox.add_child(this._searchEntry);
      searchItem.add_child(searchBox);
      this.menu.addMenuItem(searchItem);

      this._searchEntry.clutter_text.connect('text-changed', () => {
        this._searchText = this._searchEntry.get_text().trim().toLowerCase();
        this._rebuildProjectItems();
      });

      // Autofocus search bar when opening the menu
      this.menu.connect('open-state-changed', (_menu, isOpen) => {
        if (!isOpen)
          return;

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          try {
            this._searchEntry.grab_key_focus();
            this._searchEntry.clutter_text.set_selection(0, -1);
          } catch (e) {
            console.error(`[Code Launcher] Failed to focus search entry: ${e}`);
          }
          return GLib.SOURCE_REMOVE;
        });
      });

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
            console.error(`[Code Launcher] Failed to refocus after rescan: ${e}`);
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
          console.error(`[Code Launcher] openPreferences failed: ${e}`);
        }
      });
      this.menu.addMenuItem(openPrefsItem);

      this._scanDirChangedId = this._settings.connect('changed::scan-directory', () => {
        this._allProjects = [];
        this._hasScannedOnce = false;
        this._searchText = '';

        this._scanGeneration = 0;
        this._scanCancellable = null;
        this._searchEntry.set_text('');
        this._showNeedsRescan();
      });

      this._ignoredChangedId = this._settings.connect('changed::ignored-projects', () => {
        this._rebuildProjectItems();
      });

      this._refreshNow(false);
    }

    destroy() {
      this._scanCancellable?.cancel();
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
        return new Set(arr.map(s => s.trim()).filter(Boolean));
      } catch {
        return new Set();
      }
    }

    _showSingleDisabledLine(text) {
      this._projectsSection.removeAll();
      const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
      item.setSensitive(false);
      this._projectsSection.addMenuItem(item);
    }

    _showNeedsRescan() {
      this._showSingleDisabledLine('Directory changed — click "Rescan now"');
    }

    _rebuildProjectItems() {
      this._projectsSection.removeAll();

      const rootPath = this._settings.get_string('scan-directory');
      if (!rootPath || rootPath.trim() === '') {
        this._showSingleDisabledLine('Set a scan directory in Settings…');
        return;
      }

      if (!this._hasScannedOnce) {
        this._showSingleDisabledLine('Click "Rescan now" to scan');
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
          const label = getProjectDisplayLabel(p).toLowerCase();
          return label.includes(q) || p.toLowerCase().includes(q);
        })
        : visibleProjects;

      if (filtered.length === 0) {
        this._showSingleDisabledLine('No matches');
        return;
      }

      for (const projectPath of filtered) {
        const ideKey = pickIdeForProject(projectPath);
        const icon = getMenuIconForProject(projectPath, ideKey);

        const plainLabel = getProjectDisplayLabel(projectPath);
        const markupLabel = getProjectDisplayMarkup(projectPath);

        const menuItem = new PopupMenu.PopupImageMenuItem(plainLabel, icon);

        try {
          menuItem.actor.add_style_class_name('project-item');
          menuItem.actor.x_expand = true;
        } catch {
        }

        try {
          menuItem.label.clutter_text.set_markup(markupLabel);
        } catch (e) {
          menuItem.label.set_text(plainLabel);
          console.error(`[Code Launcher] Failed to set markup label: ${e}`);
        }

        menuItem.closeOnActivate = true;
        menuItem.connect('activate', () => {
          try {
            const app = getAppInfo(ideKey);
            app.launch_uris([Gio.File.new_for_path(projectPath).get_uri()], null);
          } catch (e) {
            Main.notifyError('Code Launcher', `Failed to launch ${ideKey} for ${projectPath}: ${e}`);
          }
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.menu.close();
            return GLib.SOURCE_REMOVE;
          });
        });

        this._projectsSection.addMenuItem(menuItem);
      }
    }

    _refreshNow(fromManualClick) {
      this._refreshNowAsync(fromManualClick).then();
    }

    async _refreshNowAsync(fromManualClick) {
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

      this._scanCancellable?.cancel();
      const cancellable = createCancellable();
      this._scanCancellable = cancellable;
      const myGen = ++this._scanGeneration;

      this._showSingleDisabledLine('Scanning…');

      let projects = [];
      try {
        projects = await scanForIdeaProjectsAsync(rootPath, {
          cancellable,
          onProgress: (count) => {
            if (myGen !== this._scanGeneration) return;
            if (count % 50 === 0)
              this._showSingleDisabledLine(`Scanning… (${count})`);
          },
        });
      } catch (e) {
        if (myGen !== this._scanGeneration) return;
        console.error(`[Code Launcher] Scan failed: ${e}`);
        this._showSingleDisabledLine(`Scan failed: ${e}`);
        return;
      } finally {
        if (this._scanCancellable === cancellable)
          this._scanCancellable = null;
      }

      if (myGen !== this._scanGeneration) return;

      this._allProjects = projects;
      this._hasScannedOnce = true;
      this._rebuildProjectItems();
    }
  });

export default class CodeLauncherExtension extends Extension {
  enable() {
    this._settings = this.getSettings();

    this._stylesheetFile = Gio.File.new_for_path(`${this.path}/stylesheet.css`);
    try {
      St.ThemeContext.get_for_stage(global.stage)
        .get_theme()
        .load_stylesheet(this._stylesheetFile);
    } catch (e) {
      console.error(`[Code Launcher] Failed to load stylesheet: ${e}`);
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
        console.error(`[Code Launcher] Failed to unload stylesheet: ${e}`);
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
