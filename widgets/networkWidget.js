import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import NM from 'gi://NM';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget, configureWidgetCaption } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';
import { readTextFileAsync } from '../core/asyncUtils.js';

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
            colSpan: params.colSpan ?? 2,
            rowSpan: params.rowSpan ?? 2,
            ...params,
        });

        this._lastRenderedTier = null;
        this._lastNetBytes = null;
        this._downloadSpeed = 0;
        this._uploadSpeed = 0;
        this._activeName = _('No connection');
        this._activeType = '';
        this._activeDevice = '';
        this._localIp = '';
        this._destroyed = false;
        this._updateInFlight = false;
        this._cancellable = new Gio.Cancellable();
        this._nmClient = null;

        this._typeLabel = null;
        this._nameLabel = null;
        this._ipLabel = null;
        this._downBadge = null;
        this._upBadge = null;
        this._ifaceBadge = null;
        this._detailLabel = null;

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
        this._initNetworkMonitoring();

        this.connect('destroy', () => {
            this._destroyed = true;
            this._cancellable.cancel();
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
            this._nmClient = null;
        });
    }

    onGeometryChanged() {
        if (this._lastRenderedTier !== this.sizeTier) {
            this._rebuildUI(this.sizeTier);
            this._updateUI();
            this.refreshAdaptiveLabels();
        }
    }

    _initNetworkMonitoring() {
        try {
            this._nmClient = NM.Client.new(this._cancellable);
        } catch {
            this._nmClient = null;
        }

        this._updateNetwork();
        if (!this.isPreview) {
            this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
                this._updateNetwork();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    async _readNetDev() {
        try {
            const text = await readTextFileAsync('/proc/net/dev', this._cancellable);
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

            return {
                rx: rxTotal,
                tx: txTotal,
                time: GLib.get_monotonic_time() / 1000000,
            };
        } catch {
            return null;
        }
    }

    _updateNMInfo() {
        if (!this._nmClient) return;

        try {
            const activeCons = this._nmClient.get_active_connections() ?? [];
            let active = activeCons.find(c => c.connection_type !== 'loopback' && c.state === NM.ActiveConnectionState.ACTIVATED);
            if (!active) active = activeCons.find(c => c.connection_type !== 'loopback') ?? activeCons[0];

            if (active) {
                this._activeName = active.id || _('Connected');
                const rawType = active.connection_type ?? '';
                const typeLabels = {
                    '802-11-wireless': 'Wi-Fi',
                    '802-3-ethernet': _('Ethernet'),
                    gsm: _('Mobile'),
                    vpn: 'VPN',
                    bluetooth: 'Bluetooth',
                };
                this._activeType = typeLabels[rawType] ?? (rawType || '');

                const devices = active.get_devices() ?? [];
                this._activeDevice = devices[0]?.get_iface() ?? '';

                const ipConfig = active.get_ip4_config();
                const addrs = ipConfig?.get_addresses() ?? [];
                const ipList = addrs.map(a => a.get_address()).filter(Boolean);
                this._localIp = ipList.length > 0 ? ipList.join(' · ') : _('No IP address');
            } else {
                this._activeName = _('No connection');
                this._activeType = '';
                this._activeDevice = '';
                this._localIp = _('No IP address');
            }
        } catch {}
    }

    async _updateNetwork() {
        if (this._destroyed || this._updateInFlight) return;
        this._updateInFlight = true;

        try {
            const currentNet = await this._readNetDev();
            if (this._destroyed) return;

            if (currentNet && this._lastNetBytes) {
                const dt = Math.max(0.1, currentNet.time - this._lastNetBytes.time);
                this._downloadSpeed = Math.max(0, (currentNet.rx - this._lastNetBytes.rx) / dt);
                this._uploadSpeed = Math.max(0, (currentNet.tx - this._lastNetBytes.tx) / dt);
            }
            this._lastNetBytes = currentNet;

            this._updateNMInfo();
            if (!this._destroyed) this._updateUI();
        } finally {
            this._updateInFlight = false;
        }
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
            text: _('Network').toUpperCase(),
            style_class: 'widget-caption',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        this._typeLabel = new St.Label({
            text: '',
            style_class: 'widget-header-side',
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(createIcon('wifi', 14));
        header.add_child(caption);
        header.add_child(this._typeLabel);
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

            this._nameLabel = new St.Label({
                text: '',
                style_class: 'widget-common-value',
            });
            this._ipLabel = new St.Label({
                text: '',
                style_class: 'widget-common-detail',
            });
            leftCol.add_child(this._nameLabel);
            leftCol.add_child(this._ipLabel);

            const rightCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._downBadge = new St.Label({
                text: '',
                style_class: 'widget-network-speed-badge',
            });
            this._upBadge = new St.Label({
                text: '',
                style_class: 'widget-network-speed-badge',
            });
            this._ifaceBadge = new St.Label({
                text: '',
                style_class: 'widget-system-detail-pill',
            });

            rightCol.add_child(this._downBadge);
            rightCol.add_child(this._upBadge);
            rightCol.add_child(this._ifaceBadge);

            splitRow.add_child(leftCol);
            splitRow.add_child(rightCol);
            contentBox.add_child(splitRow);
        } else {
            this._nameLabel = new St.Label({
                text: '',
                style_class: 'widget-common-value',
                x_expand: true,
            });
            this._ipLabel = new St.Label({
                text: '',
                style_class: 'widget-common-detail',
                x_align: Clutter.ActorAlign.START,
            });
            this._detailLabel = new St.Label({
                text: '',
                style_class: 'widget-network-detail',
                x_align: Clutter.ActorAlign.START,
            });

            contentBox.add_child(this._nameLabel);
            contentBox.add_child(this._ipLabel);
            contentBox.add_child(this._detailLabel);
        }

        this._card.add_child(contentBox);
    }

    _updateUI() {
        if (this._typeLabel) this._typeLabel.text = this._activeType;
        if (this._nameLabel) this._nameLabel.text = this._activeName;
        if (this._ipLabel) this._ipLabel.text = this._localIp;
        if (this._downBadge) this._downBadge.text = `↓ ${formatSpeed(this._downloadSpeed)}`;
        if (this._upBadge) this._upBadge.text = `↑ ${formatSpeed(this._uploadSpeed)}`;
        if (this._ifaceBadge) this._ifaceBadge.text = `${_('Interface')}: ${this._activeDevice || '—'}`;
        if (this._detailLabel) {
            this._detailLabel.text = this._activeDevice ? `${_('Interface')} ${this._activeDevice}` : '';
        }
    }
});

export const WIDGET_CONFIG = { colSpan: 2, rowSpan: 2, minColSpan: 2, maxColSpan: 6, minRowSpan: 2, maxRowSpan: 4 };

export function getWidgetMetadata() {
    return {
        name: _('Network'),
        description: _('Active connection, local IP, and network speed.'),
    };
}

export const WIDGET_NAME = 'Network';
export const WIDGET_DESCRIPTION = 'Active connection, local IP, and network speed.';
