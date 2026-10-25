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
            title: _('Dynamic background blur'),
            subtitle: _('Apply live acrylic blur using Blur my Shell or native GNOME Shell.'),
        });
        settings.bind('enable-blur', blurRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        effectsGroup.add(blurRow);

        const staticBlurRow = new Adw.SwitchRow({
            title: _('Static blur for all widgets'),
            subtitle: _('Use Blur my Shell’s static wallpaper blur instead of live blur.'),
        });
        settings.bind('static-blur', staticBlurRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        effectsGroup.add(staticBlurRow);

        const colorSchemeGroup = new Adw.PreferencesGroup({
            title: _('Color scheme'),
            description: _('Choose whether widgets use a light or dark appearance.'),
        });
        page.add(colorSchemeGroup);

        const schemeModel = new Gtk.StringList();
        schemeModel.append(_('Auto (follow system)'));
        schemeModel.append(_('Light'));
        schemeModel.append(_('Dark'));

        const schemeRow = new Adw.ComboRow({
            title: _('Widget theme'),
            subtitle: _("'Auto' follows the system color scheme."),
            model: schemeModel,
        });

        const schemeMap = ['auto', 'light', 'dark'];
        const currentScheme = settings.get_string('color-scheme');
        schemeRow.selected = Math.max(0, schemeMap.indexOf(currentScheme));

        schemeRow.connect('notify::selected', () => {
            const value = schemeMap[schemeRow.selected] ?? 'auto';
            settings.set_string('color-scheme', value);
        });
        settings.connect('changed::color-scheme', () => {
            const newScheme = settings.get_string('color-scheme');
            const idx = Math.max(0, schemeMap.indexOf(newScheme));
            if (schemeRow.selected !== idx) schemeRow.selected = idx;
        });
        colorSchemeGroup.add(schemeRow);

        const weatherPage = new Adw.PreferencesPage({
            title: _('Weather'),
            icon_name: 'weather-clear-symbolic',
        });
        window.add(weatherPage);

        const weatherGroup = new Adw.PreferencesGroup({
            title: _('Weather widget'),
            description: _('Choose how the weather widget finds and displays local conditions.'),
        });
        weatherPage.add(weatherGroup);

        const customLocationRow = new Adw.SwitchRow({
            title: _('Use a custom city'),
            subtitle: _('Use a city name instead of an approximate network location.'),
        });
        settings.bind('weather-use-custom-location', customLocationRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        weatherGroup.add(customLocationRow);

        const cityRow = new Adw.EntryRow({
            title: _('City or town'),
        });
        settings.bind('weather-location', cityRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        cityRow.sensitive = customLocationRow.active;
        customLocationRow.connect('notify::active', () => {
            cityRow.sensitive = customLocationRow.active;
        });
        weatherGroup.add(cityRow);

        const fahrenheitRow = new Adw.SwitchRow({
            title: _('Use Fahrenheit'),
            subtitle: _('Also show wind speed in miles per hour.'),
        });
        settings.bind('weather-fahrenheit', fahrenheitRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        weatherGroup.add(fahrenheitRow);

        const refreshRow = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('How often to request updated weather data, in minutes.'),
            adjustment: new Gtk.Adjustment({
                lower: 15,
                upper: 120,
                step_increment: 15,
                page_increment: 30,
            }),
        });
        settings.bind('weather-refresh-minutes', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        weatherGroup.add(refreshRow);
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
