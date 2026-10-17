import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WidgetsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(540, 520);

        const page = new Adw.PreferencesPage({
            title: _('Grid'),
            icon_name: 'view-grid-symbolic',
        });
        window.add(page);

        const widgetGroup = new Adw.PreferencesGroup({
            title: _('Desktop widgets'),
            description: _('Enable or disable each widget in the widgets folder.'),
        });
        page.add(widgetGroup);
        this._populateWidgetList(widgetGroup, settings);

        const dimensionsGroup = new Adw.PreferencesGroup({
            title: _('Desktop grid'),
            description: _('Cells fill the desktop while respecting the top bar.'),
        });
        page.add(dimensionsGroup);

        const symmetricRow = new Adw.SwitchRow({
            title: _('Square cells (symmetric)'),
            subtitle: _('Calculates proportional square cells that fill the desktop.'),
        });
        settings.bind('symmetric-grid', symmetricRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dimensionsGroup.add(symmetricRow);

        const rowsRow = new Adw.SpinRow({
            title: _('Rows'),
            subtitle: _('Number of vertical rows (e.g. 6, 7, or 8).'),
            adjustment: new Gtk.Adjustment({
                lower: 4,
                upper: 16,
                step_increment: 1,
                page_increment: 2,
            }),
        });
        settings.bind('rows', rowsRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        dimensionsGroup.add(rowsRow);

        const gapRow = new Adw.SpinRow({
            title: _('Spacing'),
            subtitle: _('Distance between cells in pixels.'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 32,
                step_increment: 2,
                page_increment: 4,
            }),
        });
        settings.bind('gap', gapRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        dimensionsGroup.add(gapRow);

        const visualGroup = new Adw.PreferencesGroup({
            title: _('Display and guides'),
        });
        page.add(visualGroup);

        const overlayRow = new Adw.SwitchRow({
            title: _('Show grid guides'),
            subtitle: _('Draw each cell outline on the desktop background.'),
        });
        settings.bind('show-grid-overlay', overlayRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visualGroup.add(overlayRow);

        const effectsGroup = new Adw.PreferencesGroup({
            title: _('Visual effects (blur)'),
            description: _('Translucent frosted-glass effect with background blur.'),
        });
        page.add(effectsGroup);

        const blurRow = new Adw.SwitchRow({
            title: _('Background blur'),
            subtitle: _('Apply acrylic blur using Blur my Shell or native GNOME Shell.'),
        });
        settings.bind('enable-blur', blurRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        effectsGroup.add(blurRow);
    }

    async _populateWidgetList(group, settings) {
        const widgetsDirectory = this.dir.get_child('widgets');
        const enumerator = widgetsDirectory.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        const filenames = [];
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() === Gio.FileType.REGULAR && info.get_name().endsWith('.js')) {
                filenames.push(info.get_name());
            }
        }
        enumerator.close(null);
        filenames.sort();
        const disabled = new Set(settings.get_strv('disabled-widgets'));

        for (const filename of filenames) {
            let module = {};
            try {
                const uri = widgetsDirectory.get_child(filename).get_uri();
                module = await import(uri);
            } catch (error) {
                console.error(`[Widgets] Could not display ${filename} in Preferences: ${error.message}`);
            }

            const row = new Adw.SwitchRow({
                title: module.WIDGET_NAME ?? filename.replace(/\.js$/, ''),
                subtitle: module.WIDGET_DESCRIPTION ?? filename,
                active: !disabled.has(filename),
            });
            row.connect('notify::active', () => {
                const updated = new Set(settings.get_strv('disabled-widgets'));
                if (row.active) {
                    updated.delete(filename);
                } else {
                    updated.add(filename);
                }
                settings.set_strv('disabled-widgets', [...updated].sort());
            });
            group.add(row);
        }
    }
}
