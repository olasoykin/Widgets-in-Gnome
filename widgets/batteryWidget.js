import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget, configureWidgetCaption } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';

export const Widget = GObject.registerClass(
class BatteryWidget extends BaseWidget {
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

        this._updateBattery();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._updateBattery();
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
            this._updateBattery();
            this.refreshAdaptiveLabels();
        }
    }

    _readText(path) {
        try {
            const [, contents] = Gio.File.new_for_path(path).load_contents(null);
            return new TextDecoder().decode(contents).trim();
        } catch (_error) {
            return '';
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

    _updateBattery() {
        const tier = this.sizeTier;
        this._lastRenderedTier = tier;

        let batteryFound = false;
        let percentage = '—';
        let status = _('Not detected');
        let level = 0;
        let health = null;
        let voltage = null;
        let powerW = null;
        let technology = '';
        let cycles = null;

        try {
            const directory = Gio.File.new_for_path('/sys/class/power_supply');
            const enumerator = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const path = `/sys/class/power_supply/${info.get_name()}`;
                if (this._readText(`${path}/type`) !== 'Battery') continue;

                batteryFound = true;
                percentage = this._readText(`${path}/capacity`);
                status = this._readText(`${path}/status`);
                level = Number(percentage);

                technology = this._readText(`${path}/technology`) || 'Li-ion';

                const chargeFull = Number(this._readText(`${path}/charge_full`) || this._readText(`${path}/energy_full`));
                const chargeDesign = Number(this._readText(`${path}/charge_full_design`) || this._readText(`${path}/energy_full_design`));
                if (chargeFull > 0 && chargeDesign > 0) {
                    health = Math.min(100, Math.round((chargeFull / chargeDesign) * 100));
                }

                const voltMicro = Number(this._readText(`${path}/voltage_now`));
                if (voltMicro > 0) {
                    voltage = (voltMicro / 1000000).toFixed(1);
                }

                const powerMicro = Number(this._readText(`${path}/power_now`));
                const currentMicro = Number(this._readText(`${path}/current_now`));
                if (powerMicro > 0) {
                    powerW = (powerMicro / 1000000).toFixed(1);
                } else if (currentMicro > 0 && voltMicro > 0) {
                    powerW = ((currentMicro * voltMicro) / 1000000000000).toFixed(1);
                }

                const cycleText = this._readText(`${path}/cycle_count`);
                if (cycleText && Number(cycleText) > 0) {
                    cycles = cycleText;
                }

                enumerator.close(null);
                break;
            }
            if (!batteryFound) enumerator.close(null);
        } catch (_error) {}

        const hasLevel = Number.isFinite(level) && batteryFound;
        const color = hasLevel && level <= 20 ? 'widget-gauge-red' : 'widget-gauge-green';

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
        const statusLabel = new St.Label({
            text: this._statusText(status),
            style_class: 'widget-header-side',
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(createIcon('battery', 14));
        header.add_child(caption);
        header.add_child(statusLabel);
        contentBox.add_child(header);

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

            const levelLabel = new St.Label({
                text: hasLevel ? `${Math.round(level)}%` : '—',
                style_class: 'widget-battery-value',
            });
            const gauge = this._createGauge(color);
            this._setGauge(gauge, hasLevel ? level / 100 : 0, color);

            leftCol.add_child(levelLabel);
            leftCol.add_child(gauge.track);

            const rightCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            if (health !== null) {
                rightCol.add_child(new St.Label({
                    text: `${_('Health')}: ${health}%`,
                    style_class: 'widget-system-detail-pill',
                }));
            }
            if (powerW !== null) {
                rightCol.add_child(new St.Label({
                    text: `${_('Power')}: ${powerW} W`,
                    style_class: 'widget-system-detail-pill',
                }));
            }
            if (voltage) {
                rightCol.add_child(new St.Label({
                    text: `${voltage} V · ${technology}`,
                    style_class: 'widget-system-detail-pill',
                }));
            }
            if (cycles) {
                rightCol.add_child(new St.Label({
                    text: `${_('Cycles')}: ${cycles}`,
                    style_class: 'widget-system-detail-pill',
                }));
            }

            splitRow.add_child(leftCol);
            splitRow.add_child(rightCol);
            contentBox.add_child(splitRow);
        } else {
            const levelLabel = new St.Label({
                text: hasLevel ? `${Math.round(level)}%` : '—',
                style_class: 'widget-battery-value',
                x_align: Clutter.ActorAlign.START,
            });
            const gauge = this._createGauge(color);
            this._setGauge(gauge, hasLevel ? level / 100 : 0, color);

            contentBox.add_child(levelLabel);
            contentBox.add_child(gauge.track);
        }

        this._card.add_child(contentBox);
    }
});

export const WIDGET_CONFIG = { colSpan: 2, rowSpan: 2, minColSpan: 2, maxColSpan: 6, minRowSpan: 2, maxRowSpan: 4 };
export const WIDGET_NAME = _('Battery');
export const WIDGET_DESCRIPTION = _('Battery level, health, and power use.');
