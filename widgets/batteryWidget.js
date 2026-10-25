import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import UPowerGlib from 'gi://UPowerGlib';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget, configureWidgetCaption } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';
import { readTextFileAsync } from '../core/asyncUtils.js';

export const Widget = GObject.registerClass(
class BatteryWidget extends BaseWidget {
    _init(params = {}) {
        super._init({
            colSpan: params.colSpan ?? 2,
            rowSpan: params.rowSpan ?? 2,
            ...params,
        });

        this._lastRenderedTier = null;
        this._upowerClient = null;
        this._upowerSignals = [];
        this._timeoutId = 0;
        this._cancellable = new Gio.Cancellable();

        this._statusLabel = null;
        this._levelLabel = null;
        this._gauge = null;
        this._healthLabel = null;
        this._powerLabel = null;
        this._techLabel = null;
        this._cyclesLabel = null;

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
        this._initBatteryMonitoring();

        this.connect('destroy', () => {
            this._cancellable.cancel();
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
            if (this._upowerClient) {
                for (const id of this._upowerSignals) {
                    try {
                        this._upowerClient.disconnect(id);
                    } catch {}
                }
                this._upowerSignals = [];
                this._upowerClient = null;
            }
        });
    }

    onGeometryChanged() {
        if (this._lastRenderedTier !== this.sizeTier) {
            this._rebuildUI(this.sizeTier);
            this._updateBattery();
            this.refreshAdaptiveLabels();
        }
    }

    _statusText(status) {
        const labels = {
            Charging: _('Charging'),
            Discharging: _('Discharging'),
            Full: _('Full'),
            'Not charging': _('Not charging'),
            Idle: _('Idle'),
            Unknown: _('Unknown'),
        };
        if (!status) return '';
        return labels[status] ?? status;
    }

    _initBatteryMonitoring() {
        if (this.isPreview) {
            this._updateBattery();
            return;
        }

        try {
            this._upowerClient = UPowerGlib.Client.new_full(this._cancellable);
            const id1 = this._upowerClient.connect('device-added', () => this._updateBattery());
            const id2 = this._upowerClient.connect('device-removed', () => this._updateBattery());
            const id3 = this._upowerClient.connect('notify', () => this._updateBattery());
            this._upowerSignals.push(id1, id2, id3);

            for (const device of this._upowerClient.get_devices()) {
                if (device.kind === UPowerGlib.DeviceKind.BATTERY) {
                    const devId = device.connect('notify', () => this._updateBattery());
                    this._upowerSignals.push(devId);
                }
            }
        } catch {
            this._upowerClient = null;
        }

        this._updateBattery();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._updateBattery();
            return GLib.SOURCE_CONTINUE;
        });
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
            text: _('Battery').toUpperCase(),
            style_class: 'widget-caption',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        this._statusLabel = new St.Label({
            text: '',
            style_class: 'widget-header-side',
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(createIcon('battery', 14));
        header.add_child(caption);
        header.add_child(this._statusLabel);
        contentBox.add_child(header);

        this._gauge = this._createGauge('widget-gauge-green');
        this._levelLabel = new St.Label({
            text: '—',
            style_class: 'widget-battery-value',
        });

        if (tier === 'medium' || tier === 'large') {
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
            leftCol.add_child(this._levelLabel);
            leftCol.add_child(this._gauge.track);

            const rightCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._healthLabel = new St.Label({ style_class: 'widget-system-detail-pill' });
            this._powerLabel = new St.Label({ style_class: 'widget-system-detail-pill' });
            this._techLabel = new St.Label({ style_class: 'widget-system-detail-pill' });
            this._cyclesLabel = new St.Label({ style_class: 'widget-system-detail-pill' });

            rightCol.add_child(this._healthLabel);
            rightCol.add_child(this._powerLabel);
            rightCol.add_child(this._techLabel);
            rightCol.add_child(this._cyclesLabel);

            splitRow.add_child(leftCol);
            splitRow.add_child(rightCol);
            contentBox.add_child(splitRow);
        } else {
            this._levelLabel.x_align = Clutter.ActorAlign.START;
            contentBox.add_child(this._levelLabel);
            contentBox.add_child(this._gauge.track);
        }

        this._card.add_child(contentBox);
    }

    async _updateBattery() {
        let batteryFound = false;
        let percentage = '—';
        let status = _('Not detected');
        let level = 0;
        let health = null;
        let voltage = null;
        let powerW = null;
        let technology = '';
        let cycles = null;

        if (this._upowerClient) {
            for (const device of this._upowerClient.get_devices()) {
                if (device.kind === UPowerGlib.DeviceKind.BATTERY) {
                    batteryFound = true;
                    level = Math.round(device.percentage);
                    percentage = `${level}%`;

                    const stateMap = {
                        [UPowerGlib.DeviceState.CHARGING]: 'Charging',
                        [UPowerGlib.DeviceState.DISCHARGING]: 'Discharging',
                        [UPowerGlib.DeviceState.FULLY_CHARGED]: 'Full',
                        [UPowerGlib.DeviceState.PENDING_CHARGE]: 'Not charging',
                        [UPowerGlib.DeviceState.PENDING_DISCHARGE]: 'Not charging',
                    };
                    status = stateMap[device.state] ?? 'Unknown';
                    if (device.voltage > 0) voltage = device.voltage.toFixed(1);
                    if (device.energy_rate > 0) powerW = device.energy_rate.toFixed(1);
                    if (device.energy_full > 0 && device.energy_full_design > 0) {
                        health = Math.min(100, Math.round((device.energy_full / device.energy_full_design) * 100));
                    }
                    technology = 'Li-ion';
                    break;
                }
            }
        }

        if (!batteryFound) {
            try {
                const dir = Gio.File.new_for_path('/sys/class/power_supply');
                const [infoList] = await new Promise((resolve) => {
                    dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
                        try {
                            const enumerator = s.enumerate_children_finish(res);
                            const list = [];
                            let item;
                            while ((item = enumerator.next_file(null)) !== null) {
                                list.push(item.get_name());
                            }
                            resolve([list]);
                        } catch {
                            resolve([[]]);
                        }
                    });
                });

                for (const name of infoList) {
                    const p = `/sys/class/power_supply/${name}`;
                    const type = (await readTextFileAsync(`${p}/type`, this._cancellable).catch(() => '')).trim();
                    if (type !== 'Battery') continue;

                    batteryFound = true;
                    percentage = (await readTextFileAsync(`${p}/capacity`, this._cancellable).catch(() => '')).trim();
                    status = (await readTextFileAsync(`${p}/status`, this._cancellable).catch(() => '')).trim();
                    level = Number(percentage) || 0;
                    break;
                }
            } catch {}
        }

        const hasLevel = Number.isFinite(level) && batteryFound;
        const color = hasLevel && level <= 20 ? 'widget-gauge-red' : 'widget-gauge-green';

        if (this._statusLabel) this._statusLabel.text = this._statusText(status);
        if (this._levelLabel) this._levelLabel.text = hasLevel ? `${Math.round(level)}%` : '—';
        if (this._gauge) this._setGauge(this._gauge, hasLevel ? level / 100 : 0, color);

        if (this._healthLabel) {
            this._healthLabel.text = health !== null ? `${_('Health')}: ${health}%` : '';
            this._healthLabel.visible = Boolean(this._healthLabel.text);
        }
        if (this._powerLabel) {
            this._powerLabel.text = powerW !== null ? `${_('Power')}: ${powerW} W` : '';
            this._powerLabel.visible = Boolean(this._powerLabel.text);
        }
        if (this._techLabel) {
            this._techLabel.text = voltage ? `${voltage} V · ${technology}` : '';
            this._techLabel.visible = Boolean(this._techLabel.text);
        }
        if (this._cyclesLabel) {
            this._cyclesLabel.text = cycles ? `${_('Cycles')}: ${cycles}` : '';
            this._cyclesLabel.visible = Boolean(this._cyclesLabel.text);
        }
    }
});

export const WIDGET_CONFIG = { colSpan: 2, rowSpan: 2, minColSpan: 2, maxColSpan: 6, minRowSpan: 2, maxRowSpan: 4 };

export function getWidgetMetadata() {
    return {
        name: _('Battery'),
        description: _('Battery level, health, and power use.'),
    };
}

export const WIDGET_NAME = 'Battery';
export const WIDGET_DESCRIPTION = 'Battery level, health, and power use.';
