import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget, configureWidgetCaption } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';
import { queryFilesystemInfoAsync } from '../core/asyncUtils.js';

const REFRESH_SECONDS = 60;

function formatBytes(bytes) {
    const gib = bytes / (1024 ** 3);
    if (gib >= 1) return `${gib.toFixed(1)} GB`;
    return `${Math.round(bytes / (1024 ** 2))} MB`;
}

async function queryMountAsync(path, cancellable) {
    try {
        const info = await queryFilesystemInfoAsync(path, 'filesystem::size,filesystem::free,filesystem::type', cancellable);
        if (!info) return null;
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
            colSpan: params.colSpan ?? 2,
            rowSpan: params.rowSpan ?? 2,
            ...params,
        });

        this._lastRenderedTier = null;
        this._cancellable = new Gio.Cancellable();
        this._updateInFlight = false;

        this._sideLabel = null;
        this._usedLabel = null;
        this._detailLabel = null;
        this._rootGauge = null;
        this._totalBadge = null;
        this._usedBadge = null;
        this._pathBadge = null;
        this._homeRow = null;
        this._homeVal = null;
        this._homeGauge = null;
        this._usedFooterBadge = null;
        this._freeFooterBadge = null;

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

        this._rebuildUI(this.sizeTier);
        this._updateDisk();

        if (!this.isPreview) {
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                this._updateDisk();
                return GLib.SOURCE_CONTINUE;
            });
        }

        this.connect('destroy', () => {
            this._cancellable.cancel();
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
        });
    }

    onGeometryChanged() {
        if (this._lastRenderedTier !== this.sizeTier) {
            this._rebuildUI(this.sizeTier);
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

    _rebuildUI(tier) {
        this._lastRenderedTier = tier;
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
        const caption = configureWidgetCaption(new St.Label({
            text: _('Disk').toUpperCase(),
            style_class: 'widget-caption',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        this._sideLabel = new St.Label({
            text: _('Storage').toUpperCase(),
            style_class: 'widget-header-side',
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(createIcon('database', 14));
        header.add_child(caption);
        header.add_child(this._sideLabel);
        contentBox.add_child(header);

        this._rootGauge = this._createGauge('widget-gauge-blue');

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

            this._usedLabel = new St.Label({ text: '', style_class: 'widget-common-value' });
            this._detailLabel = new St.Label({ text: '', style_class: 'widget-common-detail' });
            leftCol.add_child(this._usedLabel);
            leftCol.add_child(this._detailLabel);
            leftCol.add_child(this._rootGauge.track);

            const rightCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._totalBadge = new St.Label({ style_class: 'widget-system-detail-pill' });
            this._usedBadge = new St.Label({ style_class: 'widget-system-detail-pill' });
            this._pathBadge = new St.Label({ style_class: 'widget-system-detail-pill' });
            rightCol.add_child(this._totalBadge);
            rightCol.add_child(this._usedBadge);
            rightCol.add_child(this._pathBadge);

            splitRow.add_child(leftCol);
            splitRow.add_child(rightCol);
            contentBox.add_child(splitRow);
        } else if (tier === 'large') {
            this._usedLabel = new St.Label({ text: '', style_class: 'widget-common-value' });
            this._detailLabel = new St.Label({ text: '', style_class: 'widget-common-detail' });
            contentBox.add_child(this._usedLabel);
            contentBox.add_child(this._detailLabel);
            contentBox.add_child(this._rootGauge.track);

            this._homeRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-gauge-row',
                x_expand: true,
                margin_top: 8,
            });
            this._homeRow.add_child(new St.Label({ text: _('Home folder'), style_class: 'widget-gauge-label', x_expand: true }));
            this._homeVal = new St.Label({ text: '', style_class: 'widget-gauge-value' });
            this._homeRow.add_child(this._homeVal);
            this._homeGauge = this._createGauge('widget-gauge-blue');

            contentBox.add_child(this._homeRow);
            contentBox.add_child(this._homeGauge.track);

            const footer = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                margin_top: 8,
            });
            this._usedFooterBadge = new St.Label({ style_class: 'widget-badge' });
            this._freeFooterBadge = new St.Label({ style_class: 'widget-badge' });
            footer.add_child(this._usedFooterBadge);
            footer.add_child(this._freeFooterBadge);
            contentBox.add_child(footer);
        } else {
            this._usedLabel = new St.Label({
                text: '',
                style_class: 'widget-common-value',
                x_align: Clutter.ActorAlign.START,
            });
            this._detailLabel = new St.Label({
                text: '',
                style_class: 'widget-common-detail',
                x_align: Clutter.ActorAlign.START,
            });

            contentBox.add_child(this._usedLabel);
            contentBox.add_child(this._detailLabel);
            contentBox.add_child(this._rootGauge.track);
        }

        this._card.add_child(contentBox);
    }

    async _updateDisk() {
        if (this._updateInFlight) return;
        this._updateInFlight = true;

        try {
            const [rootData, homeData] = await Promise.all([
                queryMountAsync('/', this._cancellable),
                queryMountAsync(GLib.get_home_dir(), this._cancellable),
            ]);

            if (!rootData) {
                if (this._detailLabel) this._detailLabel.text = _('Not available');
                return;
            }

            const isSeparateHome = homeData && homeData.total !== rootData.total;
            const color = this._getColor(rootData.fraction);

            if (this._sideLabel) {
                this._sideLabel.text = rootData.type ? rootData.type.toUpperCase() : _('Storage').toUpperCase();
            }

            if (this.sizeTier === 'medium') {
                if (this._usedLabel) this._usedLabel.text = `${Math.round(rootData.fraction * 100)}%`;
                if (this._detailLabel) this._detailLabel.text = `${formatBytes(rootData.free)} ${_('available')}`;
                if (this._rootGauge) this._setGauge(this._rootGauge, rootData.fraction, color);
                if (this._totalBadge) this._totalBadge.text = `${_('Capacity')}: ${formatBytes(rootData.total)}`;
                if (this._usedBadge) this._usedBadge.text = `${_('In use')}: ${formatBytes(rootData.used)}`;
                if (this._pathBadge) this._pathBadge.text = `${_('Mount')}: / (${_('Root')})`;
            } else if (this.sizeTier === 'large') {
                if (this._usedLabel) this._usedLabel.text = `${Math.round(rootData.fraction * 100)}% ${_('in use')}`;
                if (this._detailLabel) this._detailLabel.text = `${formatBytes(rootData.free)} ${_('free of')} ${formatBytes(rootData.total)}`;
                if (this._rootGauge) this._setGauge(this._rootGauge, rootData.fraction, color);

                if (this._homeRow) this._homeRow.visible = Boolean(isSeparateHome);
                if (this._homeGauge) this._homeGauge.track.visible = Boolean(isSeparateHome);

                if (isSeparateHome && homeData) {
                    const homeColor = this._getColor(homeData.fraction);
                    if (this._homeVal) this._homeVal.text = `${Math.round(homeData.fraction * 100)}%`;
                    if (this._homeGauge) this._setGauge(this._homeGauge, homeData.fraction, homeColor);
                }

                if (this._usedFooterBadge) this._usedFooterBadge.text = `${_('Used')}: ${formatBytes(rootData.used)}`;
                if (this._freeFooterBadge) this._freeFooterBadge.text = `${_('Free')}: ${formatBytes(rootData.free)}`;
            } else {
                if (this._usedLabel) this._usedLabel.text = `${Math.round(rootData.fraction * 100)}%`;
                if (this._detailLabel) this._detailLabel.text = `${formatBytes(rootData.used)} ${_('of')} ${formatBytes(rootData.total)} ${_('used')}`;
                if (this._rootGauge) this._setGauge(this._rootGauge, rootData.fraction, color);
            }
        } finally {
            this._updateInFlight = false;
        }
    }
});

export const WIDGET_CONFIG = { colSpan: 2, rowSpan: 2, minColSpan: 2, maxColSpan: 6, minRowSpan: 2, maxRowSpan: 4 };

export function getWidgetMetadata() {
    return {
        name: _('Disk'),
        description: _('Free and used storage space.'),
    };
}

export const WIDGET_NAME = 'Disk';
export const WIDGET_DESCRIPTION = 'Free and used storage space.';
