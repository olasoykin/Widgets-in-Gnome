import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget, configureWidgetCaption } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';
import { readTextFileAsync } from '../core/asyncUtils.js';

const REFRESH_SECONDS = 3;

export const Widget = GObject.registerClass(
class SystemWidget extends BaseWidget {
    _init(params = {}) {
        super._init({
            colSpan: params.colSpan ?? 2,
            rowSpan: params.rowSpan ?? 2,
            ...params,
        });

        this._lastRenderedTier = null;
        this._lastCpuCounters = null;
        this._cpuFraction = 0;
        this._cancellable = new Gio.Cancellable();
        this._updateInFlight = false;

        this._sideLabel = null;
        this._cpuValue = null;
        this._cpuGauge = null;
        this._cpuDetail = null;
        this._coresBadge = null;
        this._memVal = null;
        this._memGauge = null;
        this._swapVal = null;
        this._swapGauge = null;
        this._uptimeBadge = null;
        this._tasksBadge = null;
        this._loadLabel = null;
        this._memoryValueLabel = null;
        this._memoryGauge = null;

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
        this._updateStats();

        if (!this.isPreview) {
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                this._updateStats();
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
            this._updateStats();
            this.refreshAdaptiveLabels();
        }
    }

    _formatUptime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    _calculateCpu(statText) {
        const cpuLine = statText.split('\n')[0];
        const fields = cpuLine.match(/^cpu\s+(.+)$/)?.[1]?.trim().split(/\s+/).map(Number);
        if (!fields || fields.length < 4 || fields.some(v => !Number.isFinite(v))) {
            return this._cpuFraction;
        }

        const counters = fields.slice(0, 8);
        const total = counters.reduce((sum, v) => sum + v, 0);
        const idle = fields[3] + (fields[4] ?? 0);
        const previous = this._lastCpuCounters;
        this._lastCpuCounters = { total, idle };
        if (!previous) return this._cpuFraction;

        const totalDelta = total - previous.total;
        const idleDelta = idle - previous.idle;
        if (totalDelta <= 0) return this._cpuFraction;

        this._cpuFraction = Math.max(0, Math.min(1, 1 - idleDelta / totalDelta));
        return this._cpuFraction;
    }

    _rebuildUI(tier) {
        this._lastRenderedTier = tier;
        this._card.destroy_all_children();

        const contentBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'widget-content-box',
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
            text: _('System').toUpperCase(),
            style_class: 'widget-caption',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        this._sideLabel = new St.Label({
            text: '',
            style_class: 'widget-header-side',
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(createIcon('cpu', 14));
        header.add_child(caption);
        header.add_child(this._sideLabel);
        contentBox.add_child(header);

        if (tier === 'medium') {
            const splitRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const cpuCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            const cpuTitle = new St.Label({ text: 'CPU', style_class: 'widget-gauge-label' });
            this._cpuValue = new St.Label({ text: '', style_class: 'widget-common-value widget-system-cpu-percent' });
            this._cpuGauge = this._createGauge('widget-gauge-blue');
            this._cpuDetail = new St.Label({ text: '', style_class: 'widget-gauge-value' });
            cpuCol.add_child(cpuTitle);
            cpuCol.add_child(this._cpuValue);
            cpuCol.add_child(this._cpuGauge.track);
            cpuCol.add_child(this._cpuDetail);

            const memCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            const memRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-gauge-row',
                x_expand: true,
            });
            const memTitle = new St.Label({ text: 'RAM', style_class: 'widget-gauge-label', x_expand: true });
            this._memVal = new St.Label({ text: '', style_class: 'widget-gauge-value' });
            memRow.add_child(memTitle);
            memRow.add_child(this._memVal);
            this._memGauge = this._createGauge('widget-gauge-green');

            const swapRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-gauge-row',
                x_expand: true,
                margin_top: 4,
            });
            const swapTitle = new St.Label({ text: 'SWAP', style_class: 'widget-gauge-label', x_expand: true });
            this._swapVal = new St.Label({ text: '', style_class: 'widget-gauge-value' });
            swapRow.add_child(swapTitle);
            swapRow.add_child(this._swapVal);
            this._swapGauge = this._createGauge('widget-gauge-orange');

            memCol.add_child(memRow);
            memCol.add_child(this._memGauge.track);
            memCol.add_child(swapRow);
            memCol.add_child(this._swapGauge.track);

            splitRow.add_child(cpuCol);
            splitRow.add_child(memCol);
            contentBox.add_child(splitRow);

            const footer = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                margin_top: 4,
            });
            this._uptimeBadge = new St.Label({ style_class: 'widget-system-detail-pill' });
            this._tasksBadge = new St.Label({ style_class: 'widget-system-detail-pill' });
            footer.add_child(this._uptimeBadge);
            footer.add_child(this._tasksBadge);
            contentBox.add_child(footer);
        } else if (tier === 'large') {
            const splitRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });

            const cpuBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
            });
            const cpuHeader = configureWidgetCaption(new St.Label({ text: _('CPU & Processor').toUpperCase(), style_class: 'widget-caption' }));
            this._cpuValue = new St.Label({ text: '', style_class: 'widget-common-value widget-system-cpu-percent' });
            this._cpuGauge = this._createGauge('widget-gauge-blue');
            this._cpuDetail = new St.Label({ text: '', style_class: 'widget-gauge-value' });
            this._coresBadge = new St.Label({ text: '', style_class: 'widget-gauge-value' });
            cpuBox.add_child(cpuHeader);
            cpuBox.add_child(this._cpuValue);
            cpuBox.add_child(this._cpuGauge.track);
            cpuBox.add_child(this._cpuDetail);
            cpuBox.add_child(this._coresBadge);

            const memBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
            });
            const memHeader = configureWidgetCaption(new St.Label({ text: _('Memory & Storage').toUpperCase(), style_class: 'widget-caption' }));
            this._memVal = new St.Label({ text: '', style_class: 'widget-common-value' });
            this._memGauge = this._createGauge('widget-gauge-green');
            this._swapVal = new St.Label({ text: '', style_class: 'widget-gauge-value' });
            memBox.add_child(memHeader);
            memBox.add_child(this._memVal);
            memBox.add_child(this._memGauge.track);
            memBox.add_child(this._swapVal);

            splitRow.add_child(cpuBox);
            splitRow.add_child(memBox);
            contentBox.add_child(splitRow);

            const footer = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                margin_top: 8,
            });
            this._uptimeBadge = new St.Label({ style_class: 'widget-system-detail-pill' });
            this._tasksBadge = new St.Label({ style_class: 'widget-system-detail-pill' });
            const hostBadge = new St.Label({ text: `${_('Machine')}: ${GLib.get_host_name()}`, style_class: 'widget-system-detail-pill' });
            footer.add_child(this._uptimeBadge);
            footer.add_child(this._tasksBadge);
            footer.add_child(hostBadge);
            contentBox.add_child(footer);
        } else {
            this._loadLabel = new St.Label({
                text: '',
                style_class: 'widget-common-value widget-system-cpu-percent',
                x_align: Clutter.ActorAlign.START,
            });
            const cpuCaption = new St.Label({
                text: _('CPU usage'),
                style_class: 'widget-common-detail',
                x_align: Clutter.ActorAlign.START,
            });
            this._cpuGauge = this._createGauge('widget-gauge-blue');

            const memoryRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-gauge-row',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            const memoryCaption = new St.Label({
                text: _('Memory'),
                style_class: 'widget-gauge-label',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            this._memoryValueLabel = new St.Label({
                text: '',
                style_class: 'widget-gauge-value',
                x_align: Clutter.ActorAlign.END,
            });
            memoryRow.add_child(memoryCaption);
            memoryRow.add_child(this._memoryValueLabel);
            this._memoryGauge = this._createGauge('widget-gauge-green');

            contentBox.add_child(this._loadLabel);
            contentBox.add_child(cpuCaption);
            contentBox.add_child(this._cpuGauge.track);
            contentBox.add_child(memoryRow);
            contentBox.add_child(this._memoryGauge.track);
        }

        this._card.add_child(contentBox);
    }

    async _updateStats() {
        if (this._updateInFlight) return;
        this._updateInFlight = true;

        try {
            const [loadRaw, uptimeRaw, memory, statText] = await Promise.all([
                readTextFileAsync('/proc/loadavg', this._cancellable).catch(() => ''),
                readTextFileAsync('/proc/uptime', this._cancellable).catch(() => ''),
                readTextFileAsync('/proc/meminfo', this._cancellable).catch(() => ''),
                readTextFileAsync('/proc/stat', this._cancellable).catch(() => ''),
            ]);

            const loadParts = loadRaw.split(/\s+/);
            const load1 = loadParts[0] || '0.00';
            const load5 = loadParts[1] || '0.00';
            const load15 = loadParts[2] || '0.00';
            const tasksPart = loadParts[3] || '—';

            const uptimeSecs = parseFloat(uptimeRaw.split(/\s+/)[0] || '0');
            const uptimeFormatted = this._formatUptime(uptimeSecs);

            const total = Number(memory.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0);
            const available = Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? 0);
            const swapTotal = Number(memory.match(/^SwapTotal:\s+(\d+)/m)?.[1] ?? 0);
            const swapFree = Number(memory.match(/^SwapFree:\s+(\d+)/m)?.[1] ?? 0);

            const cpuCount = Math.max(1, GLib.get_num_processors());
            const cpuFraction = this._calculateCpu(statText);
            const cpuPercent = Math.round(cpuFraction * 100);

            const usedMiB = Math.round((total - available) / 1024);
            const totalMiB = Math.round(total / 1024);
            const memoryFraction = total > 0 ? (total - available) / total : 0;
            const memoryColor = memoryFraction >= 0.9
                ? 'widget-gauge-red'
                : memoryFraction >= 0.75
                    ? 'widget-gauge-orange'
                    : 'widget-gauge-green';

            const swapUsedMiB = Math.round((swapTotal - swapFree) / 1024);
            const swapFraction = swapTotal > 0 ? (swapTotal - swapFree) / swapTotal : 0;

            if (this._sideLabel) this._sideLabel.text = `${_('Load')} ${load1}`;
            if (this._cpuValue) this._cpuValue.text = `${cpuPercent}%`;
            if (this._cpuGauge) this._setGauge(this._cpuGauge, cpuFraction, 'widget-gauge-blue');
            if (this._loadLabel) this._loadLabel.text = `${cpuPercent}%`;

            if (this._cpuDetail) {
                this._cpuDetail.text = this.sizeTier === 'large'
                    ? `${_('Averages')}: ${load1} · ${load5} · ${load15}`
                    : `${cpuCount} ${_('cores')} · ${_('Load')} ${load1}`;
            }
            if (this._coresBadge) {
                this._coresBadge.text = `${cpuCount} ${_('processing cores')}`;
            }

            if (this._memVal) {
                this._memVal.text = this.sizeTier === 'large'
                    ? `${(usedMiB / 1024).toFixed(1)} GB`
                    : `${(usedMiB / 1024).toFixed(1)} / ${(totalMiB / 1024).toFixed(1)} GB`;
            }
            if (this._memGauge) this._setGauge(this._memGauge, memoryFraction, memoryColor);
            if (this._memoryValueLabel) this._memoryValueLabel.text = `${(usedMiB / 1024).toFixed(1)} / ${(totalMiB / 1024).toFixed(1)} GB`;
            if (this._memoryGauge) this._setGauge(this._memoryGauge, memoryFraction, memoryColor);

            if (this._swapVal) {
                this._swapVal.text = swapTotal > 0 ? `${(swapUsedMiB / 1024).toFixed(1)} GB` : _('Disabled');
            }
            if (this._swapGauge) this._setGauge(this._swapGauge, swapFraction, 'widget-gauge-orange');

            if (this._uptimeBadge) this._uptimeBadge.text = `${_('Uptime')}: ${uptimeFormatted}`;
            if (this._tasksBadge) this._tasksBadge.text = `${_('Processes')}: ${tasksPart}`;
        } finally {
            this._updateInFlight = false;
        }
    }
});

export const WIDGET_CONFIG = { colSpan: 2, rowSpan: 2, minColSpan: 2, maxColSpan: 6, minRowSpan: 2, maxRowSpan: 4 };

export function getWidgetMetadata() {
    return {
        name: _('System resources'),
        description: _('CPU, memory, swap, and activity.'),
    };
}

export const WIDGET_NAME = 'System resources';
export const WIDGET_DESCRIPTION = 'CPU, memory, swap, and activity.';
