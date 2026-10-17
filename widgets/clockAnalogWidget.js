import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget } from '../core/baseWidget.js';
import { drawAnalogClockFace } from '../core/analogClockFace.js';

const INTERFACE_SETTINGS = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });

export const Widget = GObject.registerClass(
class AnalogClockWidget extends BaseWidget {
    _init(params = {}) {
        super._init({
            ...params,
            colSpan: params.colSpan ?? 2,
            rowSpan: params.rowSpan ?? 2,
            minColSpan: 2,
            maxColSpan: 4,
            minRowSpan: 2,
            maxRowSpan: 4,
        });

        this._isDarkFace = this._detectIsDarkFace();
        this._colorSchemeChangedId = 0;
        this._lastRenderedTier = null;

        this._card = new St.BoxLayout({
            style_class: `widget-card widget-clock-card widget-analog-clock-card ${this._isDarkFace ? 'theme-dark' : 'theme-light'}`,
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        this._face = new St.DrawingArea({
            style_class: 'widget-analog-clock-face',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._face.connect('repaint', () => this._drawClock());

        this._card.add_child(this._face);
        this.setCard(this._card);
        this._renderForSize();

        this._updateClock();
        this._clockTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });

        this._colorSchemeChangedId = INTERFACE_SETTINGS.connect(
            'changed::color-scheme',
            () => this._onColorSchemeChanged()
        );

        this.connect('destroy', () => {
            if (this._clockTimeoutId) {
                GLib.source_remove(this._clockTimeoutId);
                this._clockTimeoutId = 0;
            }
            if (this._colorSchemeChangedId) {
                INTERFACE_SETTINGS.disconnect(this._colorSchemeChangedId);
                this._colorSchemeChangedId = 0;
            }
        });
    }

    _updateClock() {
        const now = GLib.DateTime.new_now_local();
        if (this._timeLabel) this._timeLabel.text = now.format('%H:%M') ?? '';
        if (this._zoneLabel) this._zoneLabel.text = now.format('%Z') ?? '';
        this._face.queue_repaint();
    }

    onGeometryChanged() {
        this._renderForSize();
    }

    _renderForSize() {
        if (!this._card || !this._face) return;

        const tier = this.sizeTier;
        if (tier === this._lastRenderedTier) return;
        this._lastRenderedTier = tier;
        const isWide = this.colSpan >= 3;
        this._card.orientation = isWide
            ? Clutter.Orientation.HORIZONTAL
            : Clutter.Orientation.VERTICAL;

        for (const child of this._card.get_children()) {
            this._card.remove_child(child);
        }
        this._card.add_child(this._face);

        this._timeLabel = null;
        this._zoneLabel = null;
        if (tier === 'small') return;

        this._timeLabel = new St.Label({
            text: '',
            style_class: 'widget-analog-clock-time',
            x_align: Clutter.ActorAlign.CENTER,
        });

        if (isWide) {
            const details = new St.BoxLayout({
                style_class: 'widget-analog-clock-details widget-analog-clock-details-side',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: false,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            details.add_child(this._timeLabel);
            if (tier === 'large') {
                this._zoneLabel = new St.Label({
                    text: '',
                    style_class: 'widget-analog-clock-zone',
                    x_align: Clutter.ActorAlign.CENTER,
                });
                details.add_child(this._zoneLabel);
            }
            this._card.add_child(details);
        } else {
            this._card.add_child(this._timeLabel);
        }

        this._updateClock();
    }

    _detectIsDarkFace() {
        try {
            const scheme = INTERFACE_SETTINGS.get_string('color-scheme');
            if (scheme === 'prefer-light') return false;
            if (scheme === 'prefer-dark') return true;
        } catch (_error) {
            // Sin lectura disponible se usa la variante oscura de la extensión.
        }
        return true;
    }

    _onColorSchemeChanged() {
        const isDark = this._detectIsDarkFace();
        if (isDark === this._isDarkFace) return;
        this._isDarkFace = isDark;
        this._card.remove_style_class_name('theme-dark');
        this._card.remove_style_class_name('theme-light');
        this._card.add_style_class_name(isDark ? 'theme-dark' : 'theme-light');
        this._face.queue_repaint();
    }

    _drawClock() {
        const [width, height] = this._face.get_surface_size();
        if (width <= 0 || height <= 0) return;

        let scale = 1;
        try {
            scale = St.ThemeContext.get_for_stage(global.stage).scale_factor ?? 1;
        } catch (_error) {
            scale = 1;
        }

        const context = this._face.get_context();
        try {
            drawAnalogClockFace(context, width, height, {
                isDark: this._isDarkFace,
                scale,
            });
        } finally {
            context.$dispose();
        }
    }
});

export const WIDGET_CONFIG = {
    colSpan: 2,
    rowSpan: 2,
    minColSpan: 2,
    maxColSpan: 4,
    minRowSpan: 2,
    maxRowSpan: 4,
};

export const WIDGET_NAME = _('Clock');
export const WIDGET_DESCRIPTION = _('Analog clock with local time.');
