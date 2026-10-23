import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget } from '../core/baseWidget.js';
import { drawAnalogClockFace } from '../core/analogClockFace.js';

const INTERFACE_SETTINGS = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
const WORLD_CITIES = [
    { name: _('New York'), tz: 'America/New_York' },
    { name: _('London'), tz: 'Europe/London' },
    { name: _('Tokyo'), tz: 'Asia/Tokyo' },
    { name: _('Sydney'), tz: 'Australia/Sydney' },
];

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
        this._lastRenderedSize = null;
        this._worldClockLabels = [];

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
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._face.set_size(this._getFaceSize(), this._getFaceSize());
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
        if (this._dateLabel) this._dateLabel.text = now.format('%A, %-d %B') ?? '';
        if (this._zoneLabel) this._zoneLabel.text = now.format('%Z') ?? '';
        for (const labels of this._worldClockLabels) {
            const cityTime = this._getCityTime(now, labels.city.tz);
            if (!cityTime) continue;
            labels.time.text = cityTime.time;
            labels.offset.text = cityTime.offset;
        }
        this._face.queue_repaint();
    }

    onGeometryChanged() {
        this._renderForSize();
    }

    _getFaceSize() {
        // Vertical growth reveals more content without shifting the dial.
        // Extra width gives the face a little more room while keeping it square.
        if (this.colSpan >= 4) return 220;
        if (this.colSpan >= 3) return 156;
        return 184;
    }

    _getCityTime(now, tzIdentifier) {
        try {
            const tz = GLib.TimeZone.new_identifier(tzIdentifier);
            if (!tz) return null;
            const cityTime = now.to_timezone(tz);
            const offsetSeconds = (cityTime.get_utc_offset() - now.get_utc_offset()) / 1000000;
            const offsetHours = Math.round(offsetSeconds / 3600);
            const offset = offsetHours === 0
                ? _('Same time')
                : `${offsetHours > 0 ? '+' : ''}${offsetHours}h`;
            return { time: cityTime.format('%H:%M') ?? '', offset };
        } catch (_error) {
            return null;
        }
    }

    _buildWorldClockList(now, count) {
        const list = new St.BoxLayout({
            style_class: 'widget-clock-cities-box widget-analog-clock-cities',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
        });

        for (const city of WORLD_CITIES.slice(0, count)) {
            const cityTime = this._getCityTime(now, city.tz);
            if (!cityTime) continue;

            const row = new St.BoxLayout({
                style_class: 'widget-clock-city-row',
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const cityDetails = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            const cityName = new St.Label({
                text: city.name,
                style_class: 'widget-clock-city-name',
            });
            const offsetLabel = new St.Label({
                text: cityTime.offset,
                style_class: 'widget-clock-city-offset',
            });
            const timeLabel = new St.Label({
                text: cityTime.time,
                style_class: 'widget-clock-city-time',
                x_align: Clutter.ActorAlign.END,
            });
            cityDetails.add_child(cityName);
            cityDetails.add_child(offsetLabel);
            row.add_child(cityDetails);
            row.add_child(timeLabel);
            this._worldClockLabels.push({ city, offset: offsetLabel, time: timeLabel });
            list.add_child(row);
        }

        return list;
    }

    _renderForSize() {
        if (!this._card || !this._face) return;

        const tier = this.sizeTier;
        const sizeKey = `${this.colSpan}x${this.rowSpan}`;
        if (sizeKey === this._lastRenderedSize) return;
        this._lastRenderedSize = sizeKey;
        this._worldClockLabels = [];
        const faceSize = this._getFaceSize();
        this._face.set_size(faceSize, faceSize);
        const isWide = this.colSpan >= 3;
        this._card.orientation = isWide
            ? Clutter.Orientation.HORIZONTAL
            : Clutter.Orientation.VERTICAL;

        for (const child of this._card.get_children()) {
            this._card.remove_child(child);
        }
        this._card.add_child(this._face);

        this._timeLabel = null;
        this._dateLabel = null;
        this._zoneLabel = null;
        if (tier === 'small') return;

        this._timeLabel = new St.Label({
            text: '',
            style_class: 'widget-analog-clock-time',
            x_align: isWide ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
        });
        this._dateLabel = null;
        if (isWide) {
            this._dateLabel = new St.Label({
                text: '',
                style_class: `widget-analog-clock-date${this.colSpan === 3 ? ' widget-analog-clock-date-compact' : ''}`,
                x_align: this.colSpan === 3 ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
            });
            this._dateLabel.clutter_text.line_wrap = false;
            this._dateLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        }

        const details = new St.BoxLayout({
            style_class: `widget-analog-clock-details${isWide
                ? (this.colSpan === 3
                    ? ' widget-analog-clock-details-side widget-analog-clock-details-compact-side'
                    : ' widget-analog-clock-details-side')
                : ''}`,
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: isWide,
            y_expand: true,
            x_align: isWide && this.colSpan >= 4
                ? Clutter.ActorAlign.START
                : Clutter.ActorAlign.CENTER,
            y_align: isWide ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START,
        });
        details.add_child(this._timeLabel);
        if (this._dateLabel) details.add_child(this._dateLabel);
        this._zoneLabel = null;
        if (isWide) {
            this._zoneLabel = new St.Label({
                text: '',
                style_class: 'widget-analog-clock-zone',
                x_align: this.colSpan >= 4 ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
            });
            details.add_child(this._zoneLabel);
        }
        if ((isWide && this.rowSpan >= 3) || (!isWide && this.rowSpan >= 4)) {
            const now = GLib.DateTime.new_now_local();
            const cityCount = isWide && this.colSpan >= 4 ? 4 : 3;
            const cities = this._buildWorldClockList(now, cityCount);
            cities.margin_top = 8;
            details.add_child(cities);
        }
        this._card.add_child(details);

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
