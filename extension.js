import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
  buildSectionTree,
  escapeMarkup,
  filterSectionTree,
  getAppInfo,
  getMenuIconForProject,
  getProjectName,
  normalizePathList,
  pickIdeForProject,
  relativeToRoot,
} from './lib/utils.js';

import {createCancellable, scanForIdeaProjectsAsync} from './lib/scanner.js';

// About ~20 items visible
const LIST_MAX_HEIGHT_PX = 560;

const FALLBACK_ICON_NAME = 'applications-development-symbolic';

// Left padding: how far one nesting level shifts a row, and where depth 0 sits.
const INDENT_PX = 12;
const BASE_PAD_PX = 8;
// Projects clear the width of their header's chevron.
const PROJECT_PAD_PX = 14;

const CodeLauncherIndicator = GObject.registerClass(
  class CodeLauncherIndicator extends PanelMenu.Button {
    _init(extension) {
      super._init(0.0, 'Code Launcher');

      this._extension = extension;
      this._settings = extension.getSettings();

      this._hasScannedOnce = false;
      this._allProjects = [];
      this._searchText = '';

      this._ideKeyCache = new Map();
      this._missingIdeWarned = new Set();

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

      this.menu.connect('open-state-changed', (_menu, isOpen) => {
        if (!isOpen) {
          // Drop the search so the next open comes back to the saved section view.
          if (this._searchEntry.get_text() !== '')
            this._searchEntry.set_text('');
          return;
        }

        // Autofocus search bar when opening the menu
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
        this._ideKeyCache.clear();

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

    _getStrvSet(key) {
      try {
        const arr = this._settings.get_strv(key) ?? [];
        return new Set(arr.map(s => s.trim()).filter(Boolean));
      } catch {
        return new Set();
      }
    }

    _getIgnoredSet() {
      return this._getStrvSet('ignored-projects');
    }

    _getCollapsedSet() {
      return this._getStrvSet('collapsed-sections');
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

    // Collapsing a section keeps you where you were; changing what the list
    // contains puts you back at the top.
    _rebuildProjectItems({keepScroll = false} = {}) {
      let scroll = 0;
      try {
        scroll = keepScroll ? this._scrollView.vadjustment?.value ?? 0 : 0;
      } catch {
      }

      this._buildProjectItems();

      try {
        this._scrollView.vadjustment?.set_value(scroll);
      } catch (e) {
        console.error(`[Code Launcher] Failed to restore scroll position: ${e}`);
      }
    }

    _buildProjectItems() {
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

      const root = rootPath.trim();
      const query = this._searchText;

      let tree = buildSectionTree(visibleProjects, root);

      if (query) {
        // Matching the path relative to the scan root means typing a section
        // name pulls up everything beneath it, without the root's own
        // directories ever counting as a match.
        tree = filterSectionTree(tree,
          p => relativeToRoot(p, root).toLowerCase().includes(query));

        if (!tree) {
          this._showSingleDisabledLine('No matches');
          return;
        }
      }

      this._addTreeItems(tree, {query, collapsed: this._getCollapsedSet()});
    }

    _addTreeItems(node, ctx) {
      for (const projectPath of node.projects)
        this._projectsSection.addMenuItem(this._createProjectItem(projectPath, node.depth + 1));

      for (const child of node.children) {
        // Searching always expands what survived the filter; otherwise the
        // saved open/closed view is restored.
        const isCollapsed = !ctx.query && ctx.collapsed.has(child.key);

        this._projectsSection.addMenuItem(
          this._createSectionHeader(child, isCollapsed, !ctx.query));

        if (!isCollapsed)
          this._addTreeItems(child, ctx);
      }
    }

    // A plain header rather than a PopupSubMenuMenuItem: that widget wraps its
    // children in a second St.ScrollView nested inside ours and paints them on
    // the theme's .popup-sub-menu background.
    _createSectionHeader(node, isCollapsed, isToggleable) {
      const header = new PopupMenu.PopupBaseMenuItem({
        reactive: isToggleable,
        can_focus: isToggleable,
        style_class: 'section-header',
      });
      header.style = `padding-left: ${BASE_PAD_PX + node.depth * INDENT_PX}px;`;

      const arrow = new St.Icon({
        icon_name: isCollapsed ? 'pan-end-symbolic' : 'pan-down-symbolic',
        style_class: 'section-arrow',
        y_align: Clutter.ActorAlign.CENTER,
      });
      header.add_child(arrow);

      const label = new St.Label({
        y_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });

      try {
        // noinspection HtmlUnknownAttribute
        label.clutter_text.set_markup(
          `<span alpha="60%">${escapeMarkup(node.label)}</span> <span alpha="35%">${node.total}</span>`);
      } catch (e) {
        label.set_text(`${node.label} ${node.total}`);
        console.error(`[Code Launcher] Failed to set section markup: ${e}`);
      }

      header.add_child(label);
      header.label_actor = label;

      if (isToggleable) {
        header.closeOnActivate = false;
        header.connect('activate', () => this._toggleSection(node.key));
      }

      return header;
    }

    _createProjectItem(projectPath, depth) {
      const ideKey = this._getIdeKey(projectPath);

      const menuItem = new PopupMenu.PopupImageMenuItem(
        getProjectName(projectPath), this._getIcon(projectPath, ideKey));

      menuItem.add_style_class_name('project-item');
      menuItem.style = `padding-left: ${BASE_PAD_PX + depth * INDENT_PX + PROJECT_PAD_PX}px;`;
      menuItem.x_expand = true;
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

      return menuItem;
    }

    // Picking the IDE stats the project for marker files, and the list is
    // rebuilt on every keystroke while searching, so memoise the answer.
    _getIdeKey(projectPath) {
      let ideKey = this._ideKeyCache.get(projectPath);

      if (ideKey === undefined) {
        ideKey = pickIdeForProject(projectPath);
        this._ideKeyCache.set(projectPath, ideKey);
      }

      return ideKey;
    }

    // Resolved fresh every time on purpose: get_icon() hands back a borrowed
    // reference owned by the DesktopAppInfo, so a cached GIcon can outlive its
    // owner. Only the failure path falls back to a generic icon — that keeps a
    // single uninstalled IDE from taking down the whole menu.
    _getIcon(projectPath, ideKey) {
      try {
        return getMenuIconForProject(projectPath, ideKey);
      } catch (e) {
        if (!this._missingIdeWarned.has(ideKey)) {
          this._missingIdeWarned.add(ideKey);
          console.error(`[Code Launcher] No icon for ${ideKey}: ${e}`);
        }
        return FALLBACK_ICON_NAME;
      }
    }

    // Only ever reached from a click or Enter on a header, so the saved view
    // can never be clobbered by a rebuild or by the shell tearing the menu down.
    _toggleSection(sectionKey) {
      const collapsed = this._getCollapsedSet();
      if (!collapsed.delete(sectionKey))
        collapsed.add(sectionKey);

      this._settings.set_strv('collapsed-sections', normalizePathList(collapsed));
      this._rebuildProjectItems({keepScroll: true});
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
      this._ideKeyCache.clear();
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
