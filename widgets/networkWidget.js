import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';

const REFRESH_SECONDS = 3;

function formatSpeed(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 KB/s';
    if (bytesPerSec >= 1024 * 1024) {
        return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    return `${Math.round(bytesPerSec / 1024)} KB/s`;
}

export const Widget = GObject.registerClass(
class NetworkWidget extends BaseWidget {
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

        this._lastNetBytes = null;
        this._downloadSpeed = 0;
        this._uploadSpeed = 0;
        this._activeName = _('No connection');
        this._activeType = '';
        this._activeDevice = '';
        this._localIp = '';
        this._ipCounter = 0;

        this._updateNetwork();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._updateNetwork();
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
            this._render();
            this.refreshAdaptiveLabels();
        }
    }

    _readNetDev() {
        try {
            const [, contents] = Gio.File.new_for_path('/proc/net/dev').load_contents(null);
            const text = new TextDecoder().decode(contents);
            let rxTotal = 0;
            let txTotal = 0;

            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('Inter-') || trimmed.startsWith('face') || trimmed.startsWith('lo:')) continue;
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 10) {
                    const rx = Number(parts[1]) || 0;
                    const tx = Number(parts[9]) || 0;
                    rxTotal += rx;
                    txTotal += tx;
                }
            }
            return { rx: rxTotal, tx: txTotal, time: GLib.get_monotonic_time() / 1000000 };
        } catch (_error) {
            return null;
        }
    }

    _runCommand(argv) {
        return new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(
                    argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );
                proc.communicate_utf8_async(null, null, (p, result) => {
                    try {
                        const [, stdout] = p.communicate_utf8_finish(result);
                        resolve(p.get_successful() ? (stdout ?? '') : '');
                    } catch (_error) {
                        resolve('');
                    }
                });
            } catch (_error) {
                resolve('');
            }
        });
    }

    async _updateNetwork() {
        try {
            const currentNet = this._readNetDev();
            if (currentNet && this._lastNetBytes) {
                const dt = Math.max(0.1, currentNet.time - this._lastNetBytes.time);
                this._downloadSpeed = Math.max(0, (currentNet.rx - this._lastNetBytes.rx) / dt);
                this._uploadSpeed = Math.max(0, (currentNet.tx - this._lastNetBytes.tx) / dt);
            }
            this._lastNetBytes = currentNet;

            this._ipCounter++;
            if (this._ipCounter % 2 === 1 || !this._localIp) {
                const [names, types, devices, ip] = await Promise.all([
                    this._runCommand(['nmcli', '-t', '-f', 'NAME', 'connection', 'show', '--active']),
                    this._runCommand(['nmcli', '-t', '-f', 'TYPE', 'connection', 'show', '--active']),
                    this._runCommand(['nmcli', '-t', '-f', 'DEVICE', 'connection', 'show', '--active']),
                    this._runCommand(['ip', '-json', 'address', 'show', 'scope', 'global']),
                ]);

                const nameList = names.split('\n').map(s => s.trim()).filter(Boolean);
                const typeList = types.split('\n').map(s => s.trim()).filter(Boolean);
                const deviceList = devices.split('\n').map(s => s.trim()).filter(Boolean);

                let index = typeList.findIndex(t => t !== 'loopback');
                if (index < 0) index = 0;

                const typeLabels = {
                    wifi: 'Wi-Fi',
                    '802-11-wireless': 'Wi-Fi',
                    '802-3-ethernet': _('Ethernet'),
                    gsm: _('Mobile'),
                    cdma: _('Mobile'),
                    vpn: 'VPN',
                    bluetooth: 'Bluetooth',
                };

                const rawType = typeList[index] ?? '';
                this._activeType = typeLabels[rawType] ?? (rawType || '');
                this._activeName = nameList[index] || _('No connection');
                this._activeDevice = deviceList[index] ?? '';
                this._localIp = this._parseGlobalIp(ip) || _('No IP address');
            }

            this._render();
        } catch (_error) {}
    }

    _parseGlobalIp(json) {
        try {
            const interfaces = JSON.parse(json);
            const addresses = [];
            for (const iface of interfaces) {
                for (const addr of iface.addr_info ?? []) {
                    if (addr.family === 'inet' && addr.scope === 'global') {
                        const prefix = addr.prefixlen ? `/${addr.prefixlen}` : '';
                        addresses.push(`${addr.local}${prefix}`);
                    }
                }
            }
            return addresses.join(' · ');
        } catch (_error) {
            return '';
        }
    }

    _render() {
        const tier = this.sizeTier;
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
        const caption = new St.Label({
            text: _('Network').toUpperCase(),
            style_class: 'widget-caption',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        const typeLabel = new St.Label({
            text: this._activeType,
            style_class: 'widget-header-side',
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(createIcon('wifi', 14));
        header.add_child(caption);
        header.add_child(typeLabel);
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

            const nameLabel = new St.Label({
                text: this._activeName,
                style_class: 'widget-common-value',
            });
            const ipLabel = new St.Label({
                text: this._localIp,
                style_class: 'widget-common-detail',
            });

            leftCol.add_child(nameLabel);
            leftCol.add_child(ipLabel);

            const rightCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const downBadge = new St.Label({
                text: `↓ ${formatSpeed(this._downloadSpeed)}`,
                style_class: 'widget-network-speed-badge',
            });
            const upBadge = new St.Label({
                text: `↑ ${formatSpeed(this._uploadSpeed)}`,
                style_class: 'widget-network-speed-badge',
            });
            const ifaceBadge = new St.Label({
                text: `${_('Interface')}: ${this._activeDevice || '—'}`,
                style_class: 'widget-system-detail-pill',
            });

            rightCol.add_child(downBadge);
            rightCol.add_child(upBadge);
            rightCol.add_child(ifaceBadge);

            splitRow.add_child(leftCol);
            splitRow.add_child(rightCol);
            contentBox.add_child(splitRow);
        } else {
            const nameLabel = new St.Label({
                text: this._activeName,
                style_class: 'widget-common-value',
                x_expand: true,
            });
            const ipLabel = new St.Label({
                text: this._localIp,
                style_class: 'widget-common-detail',
                x_align: Clutter.ActorAlign.START,
            });
            const detailLabel = new St.Label({
                text: this._activeDevice ? `${_('Interface')} ${this._activeDevice}` : '',
                style_class: 'widget-network-detail',
                x_align: Clutter.ActorAlign.START,
            });

            contentBox.add_child(nameLabel);
            contentBox.add_child(ipLabel);
            contentBox.add_child(detailLabel);
        }

        this._card.add_child(contentBox);
    }
});

export const WIDGET_CONFIG = { colSpan: 2, rowSpan: 2, minColSpan: 2, maxColSpan: 6, minRowSpan: 2, maxRowSpan: 4 };
export const WIDGET_NAME = _('Network');
export const WIDGET_DESCRIPTION = _('Active connection, local IP, and network speed.');