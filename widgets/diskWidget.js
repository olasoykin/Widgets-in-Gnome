import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';

const REFRESH_SECONDS = 60;

function formatBytes(bytes) {
    const gib = bytes / (1024 ** 3);
    if (gib >= 1) return `${gib.toFixed(1)} GB`;
    return `${Math.round(bytes / (1024 ** 2))} MB`;
}

function queryMount(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const info = file.query_filesystem_info('filesystem::size,filesystem::free,filesystem::type', null);
        const total = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        const type = info.get_attribute_string('filesystem::type') || '';
        if (Number.isFinite(total) && total > 0 && Number.isFinite(free)) {
            const used = total - free;
            const fraction = used / total;
            return { path, total, free, used, fraction, type };
        }
    } catch (_error) {}
    return null;
}

export const Widget = GObject.registerClass(
class DiskWidget extends BaseWidget {
    _init(params = {}) {
        super._init({
            ...params,
            colSpan: params.colSpan ?? 2,
            rowSpan: params.rowSpan ?? 2,
        });

        this._lastRenderedTier = null;
        this._card = new St.BoxLayout({
            style_class: 'widget-card widget-common-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.setCard(this._card);

        this._updateDisk();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._updateDisk();
            return GLib.SOURCE_CONTINUE;
        });

        this.connect('destroy', () => {
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
        });
    }

    onGeometryChanged() {
        if (this._lastRenderedTier !== this.sizeTier) {
            this._updateDisk();
            this.refreshAdaptiveLabels();
        }
    }

    _getColor(fraction) {
        return fraction >= 0.9
            ? 'widget-gauge-red'
            : fraction >= 0.75
                ? 'widget-gauge-orange'
                : 'widget-gauge-blue';
    }

    _updateDisk() {
        const tier = this.sizeTier;
        this._lastRenderedTier = tier;

        const rootData = queryMount('/');
        const homeData = queryMount(GLib.get_home_dir());
        const isSeparateHome = homeData && homeData.total !== rootData?.total;

        this._card.destroy_all_children();

        const contentBox = new St.BoxLayout({
            style_class: 'widget-content-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'widget-header',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        const caption = new St.Label({
            text: _('Disk').toUpperCase(),
            style_class: 'widget-caption',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        const sideLabel = new St.Label({
            text: rootData?.type ? rootData.type.toUpperCase() : _('Storage').toUpperCase(),
            style_class: 'widget-header-side',
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(createIcon('database', 14));
        header.add_child(caption);
        header.add_child(sideLabel);
        contentBox.add_child(header);

        if (!rootData) {
            const errLabel = new St.Label({
                text: _('Not available'),
                style_class: 'widget-common-detail',
            });
            contentBox.add_child(errLabel);
            this._card.add_child(contentBox);
            return;
        }

        const color = this._getColor(rootData.fraction);

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

            const usedLabel = new St.Label({
                text: `${Math.round(rootData.fraction * 100)}%`,
                style_class: 'widget-common-value',
            });
            const freeHighlight = new St.Label({
                text: `${formatBytes(rootData.free)} ${_('available')}`,
                style_class: 'widget-common-detail',
            });
            const rootGauge = this._createGauge(color);
            this._setGauge(rootGauge, rootData.fraction, color);

            leftCol.add_child(usedLabel);
            leftCol.add_child(freeHighlight);
            leftCol.add_child(rootGauge.track);

            const rightCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const totalBadge = new St.Label({
                text: `${_('Capacity')}: ${formatBytes(rootData.total)}`,
                style_class: 'widget-system-detail-pill',
            });
            const usedBadge = new St.Label({
                text: `${_('In use')}: ${formatBytes(rootData.used)}`,
                style_class: 'widget-system-detail-pill',
            });
            const pathBadge = new St.Label({
                text: `${_('Mount')}: / (${_('Root')})`,
                style_class: 'widget-system-detail-pill',
            });

            rightCol.add_child(totalBadge);
            rightCol.add_child(usedBadge);
            rightCol.add_child(pathBadge);

            splitRow.add_child(leftCol);
            splitRow.add_child(rightCol);
            contentBox.add_child(splitRow);
        } else if (tier === 'large') {
            const mainLabel = new St.Label({
                text: `${Math.round(rootData.fraction * 100)}% ${_('in use')}`,
                style_class: 'widget-common-value',
            });
            const mainDetail = new St.Label({
                text: `${formatBytes(rootData.free)} ${_('free of')} ${formatBytes(rootData.total)}`,
                style_class: 'widget-common-detail',
            });
            const rootGauge = this._createGauge(color);
            this._setGauge(rootGauge, rootData.fraction, color);

            contentBox.add_child(mainLabel);
            contentBox.add_child(mainDetail);
            contentBox.add_child(rootGauge.track);

            if (isSeparateHome && homeData) {
                const homeColor = this._getColor(homeData.fraction);
                const homeRow = new St.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL,
                    style_class: 'widget-gauge-row',
                    x_expand: true,
                    margin_top: 8,
                });
                homeRow.add_child(new St.Label({ text: _('Home folder'), style_class: 'widget-gauge-label', x_expand: true }));
                homeRow.add_child(new St.Label({ text: `${Math.round(homeData.fraction * 100)}%`, style_class: 'widget-gauge-value' }));

                const homeGauge = this._createGauge(homeColor);
                this._setGauge(homeGauge, homeData.fraction, homeColor);

                contentBox.add_child(homeRow);
                contentBox.add_child(homeGauge.track);
            }

            const footer = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                margin_top: 8,
            });
            footer.add_child(new St.Label({ text: `${_('Used')}: ${formatBytes(rootData.used)}`, style_class: 'widget-badge' }));
            footer.add_child(new St.Label({ text: `${_('Free')}: ${formatBytes(rootData.free)}`, style_class: 'widget-badge' }));
            contentBox.add_child(footer);
        } else {
            const usedLabel = new St.Label({
                text: `${Math.round(rootData.fraction * 100)}%`,
                style_class: 'widget-common-value',
                x_align: Clutter.ActorAlign.START,
            });
            const detailLabel = new St.Label({
                text: `${formatBytes(rootData.used)} ${_('of')} ${formatBytes(rootData.total)} ${_('used')}`,
                style_class: 'widget-common-detail',
                x_align: Clutter.ActorAlign.START,
            });
            const gauge = this._createGauge(color);
            this._setGauge(gauge, rootData.fraction, color);

            contentBox.add_child(usedLabel);
            contentBox.add_child(detailLabel);
            contentBox.add_child(gauge.track);
        }

        this._card.add_child(contentBox);
    }
});

export const WIDGET_CONFIG = { colSpan: 2, rowSpan: 2, minColSpan: 2, maxColSpan: 6, minRowSpan: 2, maxRowSpan: 4 };
export const WIDGET_NAME = _('Disk');
export const WIDGET_DESCRIPTION = _('Free and used storage space.');