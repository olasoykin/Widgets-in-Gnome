import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { gettext as _, ngettext } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';

export const Widget = GObject.registerClass(
class CalendarWidget extends BaseWidget {
    _init(params = {}) {
        super._init({
            ...params,
            colSpan: params.colSpan ?? 2,
            rowSpan: params.rowSpan ?? 2,
        });

        this._disableAdaptiveText = true;
        this._lastRenderedTier = null;
        this._card = new St.BoxLayout({
            style_class: 'widget-card widget-calendar-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.setCard(this._card);

        this._updateDate();
        if (!this.isPreview) {
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
                this._updateDate();
                return GLib.SOURCE_CONTINUE;
            });
        }

        this.connect('destroy', () => {
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
        });
    }

    onGeometryChanged() {
        if (this._lastRenderedTier !== this.sizeTier) {
            this._updateDate();
            this.refreshAdaptiveLabels();
        }
    }

    _buildCompactCell(text, { header = false, today = false, dim = false } = {}) {
        const classes = ['widget-calendar-compact-cell'];
        if (today) classes.push('widget-calendar-compact-cell-today');

        const cell = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: classes.join(' '),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const labelClasses = ['widget-calendar-compact-label'];
        if (header) labelClasses.push('widget-calendar-compact-label-header');
        if (today) labelClasses.push('widget-calendar-compact-label-today');
        if (dim) labelClasses.push('widget-calendar-compact-label-dim');
        cell.add_child(new St.Label({
            text,
            style_class: labelClasses.join(' '),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return cell;
    }

    _buildMonthGrid(date, compact = false) {
        const gridBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: compact
                ? 'widget-calendar-grid-box widget-calendar-grid-box-compact'
                : 'widget-calendar-grid-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const headerRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'widget-calendar-grid-row',
            x_align: Clutter.ActorAlign.CENTER,
        });
        const headers = Array.from({ length: 7 }, (_, index) => {
            const date = new Date(Date.UTC(2024, 0, 1 + index, 12));
            return new Intl.DateTimeFormat(undefined, { weekday: 'narrow', timeZone: 'UTC' }).format(date);
        });
        for (const h of headers) {
            headerRow.add_child(compact
                ? this._buildCompactCell(h, { header: true })
                : new St.Label({ text: h, style_class: 'widget-calendar-cell-header' }));
        }
        gridBox.add_child(headerRow);

        const year = date.getFullYear();
        const month = date.getMonth();
        const today = date.getDate();
        const firstDayWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const prevMonthDays = new Date(year, month, 0).getDate();

        let dayCounter = 1;
        let nextMonthCounter = 1;

        for (let rowIdx = 0; rowIdx < 6; rowIdx++) {
            const row = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-calendar-grid-row',
                x_align: Clutter.ActorAlign.CENTER,
            });

            for (let colIdx = 0; colIdx < 7; colIdx++) {
                const cellIndex = rowIdx * 7 + colIdx;
                let text = '';
                let isToday = false;
                let isDim = false;

                if (cellIndex < firstDayWeekday) {
                    text = String(prevMonthDays - firstDayWeekday + cellIndex + 1);
                    isDim = true;
                } else if (dayCounter <= daysInMonth) {
                    text = String(dayCounter);
                    if (dayCounter === today) isToday = true;
                    dayCounter++;
                } else {
                    text = String(nextMonthCounter++);
                    isDim = true;
                }

                row.add_child(compact
                    ? this._buildCompactCell(text, { today: isToday, dim: isDim })
                    : new St.Label({
                        text,
                        style_class: isToday
                            ? 'widget-calendar-cell widget-calendar-cell-today'
                            : (isDim ? 'widget-calendar-cell widget-calendar-cell-dim' : 'widget-calendar-cell'),
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                    }));
            }

            gridBox.add_child(row);
        }

        return gridBox;
    }

    _updateDate() {
        const now = GLib.DateTime.new_now_local();
        const jsDate = new Date();
        const tier = this.sizeTier;
        this._lastRenderedTier = tier;

        const weekday = now.format('%A') ?? '';
        const dayNumber = now.format('%-d');
        const monthYear = now.format('%B %Y') ?? '';
        const monthFormatted = monthYear.charAt(0).toUpperCase() + monthYear.slice(1);

        this._card.destroy_all_children();

        const contentBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'widget-content-box',
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
                style_class: 'widget-split-col',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const weekdayLabel = new St.Label({
                text: weekday.toUpperCase(),
                style_class: 'widget-calendar-weekday widget-calendar-weekday-compact',
                x_align: Clutter.ActorAlign.START,
                x_expand: true,
            });
            weekdayLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            weekdayLabel.clutter_text.line_wrap = false;
            const dateLabel = new St.Label({
                text: dayNumber,
                style_class: 'widget-calendar-day',
                x_align: Clutter.ActorAlign.START,
            });
            const monthLabel = new St.Label({
                text: monthFormatted,
                style_class: 'widget-calendar-month',
                x_align: Clutter.ActorAlign.START,
            });

            leftCol.add_child(weekdayLabel);
            leftCol.add_child(dateLabel);
            leftCol.add_child(monthLabel);

            const rightCol = this._buildMonthGrid(jsDate, true);

            splitRow.add_child(leftCol);
            splitRow.add_child(rightCol);
            contentBox.add_child(splitRow);
        } else if (tier === 'large') {
            const splitRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const leftCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });

            const weekdayLabel = new St.Label({
                text: weekday.toUpperCase(),
                style_class: 'widget-calendar-weekday',
                x_align: Clutter.ActorAlign.START,
            });
            const dateLabel = new St.Label({
                text: dayNumber,
                style_class: 'widget-calendar-day',
                x_align: Clutter.ActorAlign.START,
            });
            const monthLabel = new St.Label({
                text: monthFormatted,
                style_class: 'widget-calendar-month',
                x_align: Clutter.ActorAlign.START,
            });

            leftCol.add_child(weekdayLabel);
            leftCol.add_child(dateLabel);
            leftCol.add_child(monthLabel);

            const grid = this._buildMonthGrid(jsDate);
            splitRow.add_child(leftCol);
            splitRow.add_child(grid);
            contentBox.add_child(splitRow);

            const dayOfYear = now.get_day_of_year();
            const weekOfYear = now.get_week_of_year();
            const daysInYear = now.get_year() % 4 === 0 ? 366 : 365;
            const remaining = daysInYear - dayOfYear;

            const footer = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                margin_top: 8,
            });

            const weekBadge = new St.Label({
                text: _('Week %d').replace('%d', String(weekOfYear)),
                style_class: 'widget-badge',
            });
            const dayBadge = new St.Label({
                text: _('Day %d of the year').replace('%d', String(dayOfYear)),
                style_class: 'widget-badge',
            });
            const remBadge = new St.Label({
                text: ngettext('%d day remaining', '%d days remaining', remaining)
                    .replace('%d', String(remaining)),
                style_class: 'widget-badge',
            });

            footer.add_child(weekBadge);
            footer.add_child(dayBadge);
            footer.add_child(remBadge);
            contentBox.add_child(footer);
        } else {
            const weekdayLabel = new St.Label({
                text: weekday.toUpperCase(),
                style_class: 'widget-calendar-weekday',
                x_align: Clutter.ActorAlign.START,
            });
            const dateLabel = new St.Label({
                text: dayNumber,
                style_class: 'widget-calendar-day',
                x_align: Clutter.ActorAlign.START,
            });
            const monthLabel = new St.Label({
                text: monthFormatted,
                style_class: 'widget-calendar-month',
                x_align: Clutter.ActorAlign.START,
            });

            contentBox.add_child(weekdayLabel);
            contentBox.add_child(dateLabel);
            contentBox.add_child(monthLabel);
        }

        this._card.add_child(contentBox);
    }
});

export const WIDGET_CONFIG = { colSpan: 2, rowSpan: 2, minColSpan: 2, maxColSpan: 6, minRowSpan: 2, maxRowSpan: 4 };

export function getWidgetMetadata() {
    return {
        name: _('Calendar'),
        description: _('Current date and monthly grid.'),
    };
}

export const WIDGET_NAME = 'Calendar';
export const WIDGET_DESCRIPTION = 'Current date and monthly grid.';
