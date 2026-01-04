import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CodeLauncherPrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

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

    window.add(page);

    settings.connect('changed::scan-directory', updateDirLabel);
  }
}
