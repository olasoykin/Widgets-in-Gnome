import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';

const WORLD_CITIES = [
    { name: _('New York'), tz: 'America/New_York' },
    { name: _('London'), tz: 'Europe/London' },
    { name: _('Tokyo'), tz: 'Asia/Tokyo' },
    { name: _('Sydney'), tz: 'Australia/Sydney' },
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
        });

        this._lastRenderedTier = null;
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

        this._updateClock();
        this._clockTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            () => {
                this._updateClock();
                return GLib.SOURCE_CONTINUE;
            }
        );

        this.connect('destroy', () => {
            if (this._clockTimeoutId) {
                GLib.source_remove(this._clockTimeoutId);
                this._clockTimeoutId = 0;
            }
        });
    }

    onGeometryChanged() {
        if (this._lastRenderedTier !== this.sizeTier) {
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

    _buildWorldClockList(now, count = 3) {
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
            const data = this._getCityTime(now, city.tz);
            if (!data) continue;

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
                text: city.name,
                style_class: 'widget-clock-city-name',
            });
            const offsetLabel = new St.Label({
                text: data.offset,
                style_class: 'widget-clock-city-offset',
            });
            left.add_child(nameLabel);
            left.add_child(offsetLabel);

            const timeLabel = new St.Label({
                text: data.time,
                style_class: 'widget-clock-city-time',
                x_align: Clutter.ActorAlign.END,
            });

            row.add_child(left);
            row.add_child(timeLabel);
            box.add_child(row);
        }

        return box;
    }

    _updateClock() {
        const now = GLib.DateTime.new_now_local();
        const tier = this.sizeTier;
        this._lastRenderedTier = tier;

        const timeString = now.format('%H:%M') ?? '';
        const secondsString = now.format('%S') ?? '';
        const dateString = now.format('%A, %-d %B') ?? '';
        const tzName = now.format('%Z') ?? 'Local';

        this._card.destroy_all_children();

        const contentBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'widget-clock-content',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
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

            const timeBox = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'widget-clock-time-row',
            });
            const timeLabel = new St.Label({
                text: timeString,
                style_class: 'widget-clock-time',
            });
            const secondsLabel = new St.Label({
                text: secondsString,
                style_class: 'widget-clock-seconds',
                y_align: Clutter.ActorAlign.END,
            });
            timeBox.add_child(timeLabel);
            timeBox.add_child(secondsLabel);

            const dateLabel = new St.Label({
                text: dateString,
                style_class: 'widget-clock-date',
                x_align: Clutter.ActorAlign.START,
            });

            leftCol.add_child(timeBox);
            leftCol.add_child(dateLabel);

            const rightCol = this._buildWorldClockList(now, 3);

            splitRow.add_child(leftCol);
            splitRow.add_child(rightCol);
            contentBox.add_child(splitRow);
        } else if (tier === 'large') {
            const timeBox = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'widget-clock-time-row',
            });
            const timeLabel = new St.Label({
                text: timeString,
                style_class: 'widget-clock-time',
            });
            const secondsLabel = new St.Label({
                text: secondsString,
                style_class: 'widget-clock-seconds',
                y_align: Clutter.ActorAlign.END,
            });
            timeBox.add_child(timeLabel);
            timeBox.add_child(secondsLabel);

            const dateLabel = new St.Label({
                text: dateString,
                style_class: 'widget-clock-date',
                x_align: Clutter.ActorAlign.START,
            });

            contentBox.add_child(timeBox);
            contentBox.add_child(dateLabel);

            const worldBox = this._buildWorldClockList(now, 4);
            worldBox.margin_top = 8;
            contentBox.add_child(worldBox);
        } else {
            const timeBox = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'widget-clock-time-row',
            });
            const timeLabel = new St.Label({
                text: timeString,
                style_class: 'widget-clock-time',
            });
            const secondsLabel = new St.Label({
                text: secondsString,
                style_class: 'widget-clock-seconds',
                y_align: Clutter.ActorAlign.END,
            });
            timeBox.add_child(timeLabel);
            timeBox.add_child(secondsLabel);

            const dateLabel = new St.Label({
                text: dateString,
                style_class: 'widget-clock-date',
                x_align: Clutter.ActorAlign.START,
            });

            contentBox.add_child(timeBox);
            contentBox.add_child(dateLabel);
        }

        this._card.add_child(contentBox);
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

export const WIDGET_NAME = _('Clock');
export const WIDGET_DESCRIPTION = _('Local time and world clock.');
