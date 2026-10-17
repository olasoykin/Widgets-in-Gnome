import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';

export const Widget = GObject.registerClass(
class SystemWidget extends BaseWidget {
    _init(params = {}) {
        super._init({
            ...params,
            colSpan: params.colSpan ?? 2,
            rowSpan: params.rowSpan ?? 2,
        });

        this._lastRenderedTier = null;
        this._lastCpuCounters = null;
        this._cpuFraction = 0;
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

        this._updateStats();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateStats();
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
            this._updateStats();
            this.refreshAdaptiveLabels();
        }
    }

    _readText(path) {
        try {
            const [, contents] = Gio.File.new_for_path(path).load_contents(null);
            return new TextDecoder().decode(contents);
        } catch (_error) {
            return '';
        }
    }

    _formatUptime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    _readCpuUsage() {
        const cpuLine = this._readText('/proc/stat').split('\n')[0];
        const fields = cpuLine.match(/^cpu\s+(.+)$/)?.[1]?.trim().split(/\s+/).map(Number);
        if (!fields || fields.length < 4 || fields.some(value => !Number.isFinite(value))) {
            return this._cpuFraction;
        }

        const counters = fields.slice(0, 8);
        const total = counters.reduce((sum, value) => sum + value, 0);
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

    _updateStats() {
        const tier = this.sizeTier;
        this._lastRenderedTier = tier;

        const loadRaw = this._readText('/proc/loadavg');
        const loadParts = loadRaw.split(/\s+/);
        const load1 = loadParts[0] || '0.00';
        const load5 = loadParts[1] || '0.00';
        const load15 = loadParts[2] || '0.00';
        const tasksPart = loadParts[3] || '—';

        const uptimeRaw = this._readText('/proc/uptime');
        const uptimeSecs = parseFloat(uptimeRaw.split(/\s+/)[0] || '0');
        const uptimeFormatted = this._formatUptime(uptimeSecs);

        const memory = this._readText('/proc/meminfo');
        const total = Number(memory.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0);
        const available = Number(memory.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? 0);
        const free = Number(memory.match(/^MemFree:\s+(\d+)/m)?.[1] ?? 0);
        const cached = Number(memory.match(/^Cached:\s+(\d+)/m)?.[1] ?? 0);
        const swapTotal = Number(memory.match(/^SwapTotal:\s+(\d+)/m)?.[1] ?? 0);
        const swapFree = Number(memory.match(/^SwapFree:\s+(\d+)/m)?.[1] ?? 0);

        const cpuCount = Math.max(1, GLib.get_num_processors());
        const cpuFraction = this._readCpuUsage();
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
        const swapTotalMiB = Math.round(swapTotal / 1024);
        const swapFraction = swapTotal > 0 ? (swapTotal - swapFree) / swapTotal : 0;

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
        const caption = new St.Label({
            text: _('System').toUpperCase(),
            style_class: 'widget-caption',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        const sideLabel = new St.Label({
            text: `${_('Load')} ${load1}`,
            style_class: 'widget-header-side',
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(createIcon('cpu', 14));
        header.add_child(caption);
        header.add_child(sideLabel);
        contentBox.add_child(header);

        if (tier === 'medium') {
            const splitRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const cpuCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            const cpuTitle = new St.Label({
                text: 'CPU',
                style_class: 'widget-gauge-label',
            });
            const cpuValue = new St.Label({
                text: `${cpuPercent}%`,
                style_class: 'widget-common-value',
            });
            const cpuGauge = this._createGauge('widget-gauge-blue');
            this._setGauge(cpuGauge, cpuFraction, 'widget-gauge-blue');
            const cpuDetail = new St.Label({
                text: `${cpuCount} ${_('cores')} · ${_('Load')} ${load1}`,
                style_class: 'widget-gauge-value',
            });

            cpuCol.add_child(cpuTitle);
            cpuCol.add_child(cpuValue);
            cpuCol.add_child(cpuGauge.track);
            cpuCol.add_child(cpuDetail);

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
            const memTitle = new St.Label({
                text: 'RAM',
                style_class: 'widget-gauge-label',
                x_expand: true,
            });
            const memVal = new St.Label({
                text: `${(usedMiB / 1024).toFixed(1)} / ${(totalMiB / 1024).toFixed(1)} GB`,
                style_class: 'widget-gauge-value',
            });
            memRow.add_child(memTitle);
            memRow.add_child(memVal);

            const memGauge = this._createGauge(memoryColor);
            this._setGauge(memGauge, memoryFraction, memoryColor);

            const swapRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-gauge-row',
                x_expand: true,
                margin_top: 4,
            });
            const swapTitle = new St.Label({
                text: 'SWAP',
                style_class: 'widget-gauge-label',
                x_expand: true,
            });
            const swapVal = new St.Label({
                text: swapTotal > 0 ? `${(swapUsedMiB / 1024).toFixed(1)} GB` : _('Disabled'),
                style_class: 'widget-gauge-value',
            });
            swapRow.add_child(swapTitle);
            swapRow.add_child(swapVal);

            const swapGauge = this._createGauge('widget-gauge-orange');
            this._setGauge(swapGauge, swapFraction, 'widget-gauge-orange');

            memCol.add_child(memRow);
            memCol.add_child(memGauge.track);
            memCol.add_child(swapRow);
            memCol.add_child(swapGauge.track);

            splitRow.add_child(cpuCol);
            splitRow.add_child(memCol);
            contentBox.add_child(splitRow);

            const footer = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                margin_top: 4,
            });
            const uptimeBadge = new St.Label({
                text: `${_('Uptime')}: ${uptimeFormatted}`,
                style_class: 'widget-system-detail-pill',
            });
            const tasksBadge = new St.Label({
                text: `${_('Processes')}: ${tasksPart}`,
                style_class: 'widget-system-detail-pill',
            });
            footer.add_child(uptimeBadge);
            footer.add_child(tasksBadge);
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
            const cpuHeader = new St.Label({ text: _('CPU & Processor').toUpperCase(), style_class: 'widget-caption' });
            const cpuValue = new St.Label({ text: `${cpuPercent}%`, style_class: 'widget-common-value' });
            const cpuGauge = this._createGauge('widget-gauge-blue');
            this._setGauge(cpuGauge, cpuFraction, 'widget-gauge-blue');
            const loadBadge = new St.Label({ text: `${_('Averages')}: ${load1} · ${load5} · ${load15}`, style_class: 'widget-gauge-value' });
            const coresBadge = new St.Label({ text: `${cpuCount} ${_('processing cores')}`, style_class: 'widget-gauge-value' });

            cpuBox.add_child(cpuHeader);
            cpuBox.add_child(cpuValue);
            cpuBox.add_child(cpuGauge.track);
            cpuBox.add_child(loadBadge);
            cpuBox.add_child(coresBadge);

            const memBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
            });
            const memHeader = new St.Label({ text: _('Memory & Storage').toUpperCase(), style_class: 'widget-caption' });
            const memValue = new St.Label({ text: `${(usedMiB / 1024).toFixed(1)} GB`, style_class: 'widget-common-value' });
            const memGauge = this._createGauge(memoryColor);
            this._setGauge(memGauge, memoryFraction, memoryColor);
            const memDetail = new St.Label({
                text: `${_('Free')}: ${(free / 1024 / 1024).toFixed(1)} GB · ${_('Cache')}: ${(cached / 1024 / 1024).toFixed(1)} GB`,
                style_class: 'widget-gauge-value',
            });
            const swapDetail = new St.Label({
                text: `Swap: ${(swapUsedMiB / 1024).toFixed(1)} ${_('of')} ${(swapTotalMiB / 1024).toFixed(1)} GB`,
                style_class: 'widget-gauge-value',
            });

            memBox.add_child(memHeader);
            memBox.add_child(memValue);
            memBox.add_child(memGauge.track);
            memBox.add_child(memDetail);
            memBox.add_child(swapDetail);

            splitRow.add_child(cpuBox);
            splitRow.add_child(memBox);
            contentBox.add_child(splitRow);

            const footer = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                margin_top: 8,
            });
            footer.add_child(new St.Label({ text: `${_('Uptime')}: ${uptimeFormatted}`, style_class: 'widget-system-detail-pill' }));
            footer.add_child(new St.Label({ text: `${_('Tasks')}: ${tasksPart}`, style_class: 'widget-system-detail-pill' }));
            footer.add_child(new St.Label({ text: `${_('Machine')}: ${GLib.get_host_name()}`, style_class: 'widget-system-detail-pill' }));
            contentBox.add_child(footer);
        } else {
            const loadLabel = new St.Label({
                text: `${cpuPercent}%`,
                style_class: 'widget-common-value',
                x_align: Clutter.ActorAlign.START,
            });
            const cpuCaption = new St.Label({
                text: _('CPU usage'),
                style_class: 'widget-common-detail',
                x_align: Clutter.ActorAlign.START,
            });

            const cpuGauge = this._createGauge('widget-gauge-blue');
            this._setGauge(cpuGauge, cpuFraction, 'widget-gauge-blue');

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
            const memoryValueLabel = new St.Label({
                text: `${(usedMiB / 1024).toFixed(1)} / ${(totalMiB / 1024).toFixed(1)} GB`,
                style_class: 'widget-gauge-value',
                x_align: Clutter.ActorAlign.END,
            });
            memoryRow.add_child(memoryCaption);
            memoryRow.add_child(memoryValueLabel);

            const memoryGauge = this._createGauge(memoryColor);
            this._setGauge(memoryGauge, memoryFraction, memoryColor);

            contentBox.add_child(loadLabel);
            contentBox.add_child(cpuCaption);
            contentBox.add_child(cpuGauge.track);
            contentBox.add_child(memoryRow);
            contentBox.add_child(memoryGauge.track);
        }

        this._card.add_child(contentBox);
    }
});

export const WIDGET_CONFIG = { colSpan: 2, rowSpan: 2, minColSpan: 2, maxColSpan: 6, minRowSpan: 2, maxRowSpan: 4 };
export const WIDGET_NAME = _('System resources');
export const WIDGET_DESCRIPTION = _('CPU, memory, swap, and activity.');
