import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget } from '../core/baseWidget.js';

const WORLD_CITIES = [
    { name: () => _('New York'), tz: 'America/New_York' },
    { name: () => _('London'), tz: 'Europe/London' },
    { name: () => _('Tokyo'), tz: 'Asia/Tokyo' },
    { name: () => _('Sydney'), tz: 'Australia/Sydney' },
];

export const Widget = GObject.registerClass(
class ClockWidget extends BaseWidget {
    _init(params = {}) {
        super._init({
            grid: params.grid,
            col: params.col ?? 2,
            row: params.row ?? 1,
            colSpan: params.colSpan ?? 2,
            rowSpan: params.rowSpan ?? 2,
            minColSpan: params.minColSpan ?? 1,
            maxColSpan: params.maxColSpan ?? 6,
            minRowSpan: params.minRowSpan ?? 1,
            maxRowSpan: params.maxRowSpan ?? 4,
            ...params,
        });

        this._lastRenderedTier = null;
        this._timeLabel = null;
        this._secondsLabel = null;
        this._dateLabel = null;
        this._cityRows = [];

        this._card = new St.BoxLayout({
            style_class: 'widget-card widget-clock-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.setCard(this._card);

        this._rebuildUI(this.sizeTier);
        this._updateClock();

        if (!this.isPreview) {
            this._clockTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                1,
                () => {
                    this._updateClock();
                    return GLib.SOURCE_CONTINUE;
                }
            );
        }

        this.connect('destroy', () => {
            if (this._clockTimeoutId) {
                GLib.source_remove(this._clockTimeoutId);
                this._clockTimeoutId = 0;
            }
        });
    }

    onGeometryChanged() {
        if (this._lastRenderedTier !== this.sizeTier) {
            this._rebuildUI(this.sizeTier);
            this._updateClock();
            this.refreshAdaptiveLabels();
        }
    }

    _getCityTime(now, tzIdentifier) {
        try {
            const tz = GLib.TimeZone.new_identifier(tzIdentifier);
            if (!tz) return null;
            const cityTime = now.to_timezone(tz);
            const offsetDiffSec = (cityTime.get_utc_offset() - now.get_utc_offset()) / 1000000;
            const offsetHours = Math.round(offsetDiffSec / 3600);
            const offsetStr = offsetHours === 0 ? _('Same time') : (offsetHours > 0 ? `+${offsetHours}h` : `${offsetHours}h`);
            return {
                time: cityTime.format('%H:%M') ?? '',
                offset: offsetStr,
            };
        } catch (_error) {
            return null;
        }
    }

    _buildWorldClockList(count = 3) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'widget-clock-cities-box',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        for (let i = 0; i < count && i < WORLD_CITIES.length; i++) {
            const city = WORLD_CITIES[i];
            const row = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-clock-city-row',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const left = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            const nameLabel = new St.Label({
                text: city.name(),
                style_class: 'widget-clock-city-name',
            });
            const offsetLabel = new St.Label({
                text: '',
                style_class: 'widget-clock-city-offset',
            });
            left.add_child(nameLabel);
            left.add_child(offsetLabel);

            const timeLabel = new St.Label({
                text: '',
                style_class: 'widget-clock-city-time',
                x_align: Clutter.ActorAlign.END,
            });

            row.add_child(left);
            row.add_child(timeLabel);
            box.add_child(row);

            this._cityRows.push({ city, timeLabel, offsetLabel });
        }

        return box;
    }

    _rebuildUI(tier) {
        this._lastRenderedTier = tier;
        this._card.destroy_all_children();
        this._cityRows = [];

        const contentBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'widget-clock-content',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const timeBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'widget-clock-time-row',
        });
        this._timeLabel = new St.Label({
            text: '',
            style_class: 'widget-clock-time',
        });
        this._secondsLabel = new St.Label({
            text: '',
            style_class: 'widget-clock-seconds',
            y_align: Clutter.ActorAlign.END,
        });
        timeBox.add_child(this._timeLabel);
        timeBox.add_child(this._secondsLabel);

        this._dateLabel = new St.Label({
            text: '',
            style_class: 'widget-clock-date',
            x_align: Clutter.ActorAlign.START,
        });

        if (tier === 'medium') {
            const splitRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const leftCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            });
            leftCol.add_child(timeBox);
            leftCol.add_child(this._dateLabel);

            const rightCol = this._buildWorldClockList(3);
            splitRow.add_child(leftCol);
            splitRow.add_child(rightCol);
            contentBox.add_child(splitRow);
        } else if (tier === 'large') {
            contentBox.add_child(timeBox);
            contentBox.add_child(this._dateLabel);

            const worldBox = this._buildWorldClockList(4);
            worldBox.margin_top = 8;
            contentBox.add_child(worldBox);
        } else {
            contentBox.add_child(timeBox);
            contentBox.add_child(this._dateLabel);
        }

        this._card.add_child(contentBox);
    }

    _updateClock() {
        const now = GLib.DateTime.new_now_local();
        if (this._timeLabel) this._timeLabel.text = now.format('%H:%M') ?? '';
        if (this._secondsLabel) this._secondsLabel.text = now.format('%S') ?? '';
        if (this._dateLabel) this._dateLabel.text = now.format('%A, %-d %B') ?? '';

        for (const { city, timeLabel, offsetLabel } of this._cityRows) {
            const data = this._getCityTime(now, city.tz);
            if (!data) continue;
            timeLabel.text = data.time;
            offsetLabel.text = data.offset;
        }
    }
});

export const WIDGET_CONFIG = {
    colSpan: 2,
    rowSpan: 2,
    minColSpan: 2,
    maxColSpan: 6,
    minRowSpan: 2,
    maxRowSpan: 4,
};

export function getWidgetMetadata() {
    return {
        name: _('Clock'),
        description: _('Local time and world clock.'),
    };
}

export const WIDGET_NAME = 'Clock';
export const WIDGET_DESCRIPTION = 'Local time and world clock.';
