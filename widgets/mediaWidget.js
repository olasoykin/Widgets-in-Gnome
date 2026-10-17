import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GdkPixbuf from 'gi://GdkPixbuf';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';
import St from 'gi://St';
import Cogl from 'gi://Cogl';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const ART_CHUNK = 64 * 1024;
const ART_RETRY_INTERVAL = 250;
const ART_RETRIES = 12;
const REMOTE_ART_TIMEOUT = 10;
const REMOTE_ART_TRIES = 3;
const COVER_CLIP_DECLS = 'uniform vec2 size; uniform vec4 box; uniform float radius;';
const COVER_CLIP_CODE = `
vec2 half_box = (box.zw - box.xy) * 0.5;
vec2 q = abs(cogl_tex_coord_in[0].xy * size - box.xy - half_box) - half_box + radius;
float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
cogl_color_out *= clamp(0.5 - d, 0.0, 1.0);
`;

const effectPadding = length => Math.round(length) + 3 - Math.ceil(length + 0.75);

class CoverClipEffect extends (Shell.GLSLEffect ?? Clutter.ShaderEffect) {
    vfunc_paint_target(...args) {
        const actor = this.get_actor();
        const scale = actor.get_resource_scale();
        const [x, y] = [actor.width, actor.height].map(length => effectPadding(length) * scale);
        const [, width, height] = this.get_target_size();
        const radius = actor.get_theme_node().get_border_radius(St.Corner.TOPLEFT);

        this._setUniform('size', [width, height]);
        this._setUniform('box', [x, y, x + actor.width * scale, y + actor.height * scale]);
        this._setUniform('radius', [radius * scale]);
        super.vfunc_paint_target(...args);
    }

    _setUniform(name, values) {
        const uniform = Shell.GLSLEffect ? this.get_uniform_location(name) : name;
        this.set_uniform_float(uniform, values.length, values);
    }
}

if (Shell.GLSLEffect) {
    Object.defineProperty(CoverClipEffect.prototype, 'vfunc_build_pipeline', {
        value() {
            this.add_glsl_snippet(
                Shell.SnippetHook?.FRAGMENT ?? Cogl.SnippetHook.FRAGMENT,
                COVER_CLIP_DECLS,
                COVER_CLIP_CODE,
                false
            );
        },
    });
} else {
    Object.defineProperty(CoverClipEffect.prototype, 'vfunc_get_static_snippet', {
        value: () => Cogl.Snippet.new(
            Cogl.SnippetHook.FRAGMENT,
            COVER_CLIP_DECLS,
            COVER_CLIP_CODE
        ),
    });
}
GObject.registerClass(CoverClipEffect);

const EqualizerBars = GObject.registerClass(
class EqualizerBars extends St.DrawingArea {
    _init(params = {}) {
        super._init({
            reactive: false,
            width: params.width ?? 18,
            height: params.height ?? 14,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'widget-media-equalizer',
            ...params,
        });
        this._isPlaying = false;
        this._barHeights = [0.25, 0.25, 0.25, 0.25];
        this._animId = 0;

        this.connect('repaint', () => this._draw());
        this.connect('destroy', () => this.stop());
    }

    setPlaying(playing) {
        if (this._isPlaying === playing && this._animId) return;
        this._isPlaying = playing;
        if (playing) {
            this._start();
        } else {
            this.stop();
            this._barHeights = [0.2, 0.2, 0.2, 0.2];
            this.queue_repaint();
        }
    }

    _start() {
        if (this._animId) return;
        this._animId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (!this._isPlaying) {
                this._animId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._barHeights = [
                0.18 + Math.random() * 0.78,
                0.28 + Math.random() * 0.70,
                0.15 + Math.random() * 0.82,
                0.22 + Math.random() * 0.75,
            ];
            this.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._animId) {
            GLib.source_remove(this._animId);
            this._animId = 0;
        }
    }

    _draw() {
        const cr = this.get_context();
        const w = this.get_width();
        const h = this.get_height();
        if (w <= 0 || h <= 0) return;

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const numBars = 4;
        const barWidth = 2.5;
        const spacing = 4;
        const startX = 2;
        const bottomY = h - 2;
        const maxH = h - 4;

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(barWidth);
        cr.setSourceRGBA(1.0, 1.0, 1.0, 0.90);

        for (let i = 0; i < numBars; i++) {
            const x = startX + i * spacing;
            const hBar = Math.max(2, Math.round(this._barHeights[i] * maxH));
            cr.moveTo(x, bottomY);
            cr.lineTo(x, bottomY - hBar);
            cr.stroke();
        }
    }
});

export const Widget = GObject.registerClass(
class MediaWidget extends BaseWidget {
    _init(params = {}) {
        super._init({
            ...params,
            colSpan: params.colSpan ?? 4,
            rowSpan: params.rowSpan ?? 3,
        });

        // Keep music metadata at its per-layout CSS size when the widget is resized.
        this._disableAdaptiveText = true;

        this._playerName = null;
        this._lastRenderedKey = null;
        this._artworkSource = null;
        this._artwork = null;
        this._artSession = null;
        this._artCancellable = null;
        this._artRetryId = 0;
        this._playerSubscriptions = new Map();
        this._nameOwnerChangedId = 0;
        this._positionAnchor = 0;
        this._positionAnchorTime = GLib.get_monotonic_time() / 1_000_000;
        this._timelineElapsedLabel = null;
        this._timelineTrack = null;
        this._timelineFill = null;
        this._currentData = {
            title: _('Nothing playing'),
            artist: _('Open a compatible player'),
            album: '',
            status: '',
            playerName: '',
            artUrl: '',
            position: 0,
            duration: 0,
        };

        this._card = new St.Widget({
            style_class: 'widget-card widget-common-card widget-media-card',
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.setCard(this._card);

        this._render();
        this._watchPlayers();
        this._timelineTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateTimeline();
            return GLib.SOURCE_CONTINUE;
        });

        this.connect('destroy', () => {
            if (this._timelineTimeoutId) {
                GLib.source_remove(this._timelineTimeoutId);
                this._timelineTimeoutId = 0;
            }
            if (this._nameOwnerChangedId) {
                Gio.DBus.session.signal_unsubscribe(this._nameOwnerChangedId);
                this._nameOwnerChangedId = 0;
            }
            for (const subscriptionId of this._playerSubscriptions.values())
                Gio.DBus.session.signal_unsubscribe(subscriptionId);
            this._playerSubscriptions.clear();
            this._stopArtworkLoading();
            this._artSession?.abort();
        });
    }

    onGeometryChanged() {
        const isTall = this.rowSpan >= 3;
        const isWideTall = this.colSpan >= 4 && this.rowSpan === 3;
        const { width, height } = this._getTargetSize();
        const coverSize = isWideTall
            ? this._getWideTallCoverSize(width, height)
            : isTall
                ? this._getTallCoverSize(width, height)
                : this.sizeTier === 'medium' ? this._getMediumCoverSize(width, height) : '';
        const layoutKey = `${this.sizeTier}-${isWideTall ? 'wide-tall' : isTall ? 'tall' : 'flat'}`;
        const key = `${layoutKey}-${coverSize}`;
        if (this._lastRenderedKey !== key) {
            if (this._isResizing && this._lastRenderedLayoutKey === layoutKey) return;
            this._render();
            this.refreshAdaptiveLabels();
        }
    }

    _getTargetSize() {
        const rect = this.grid?.getCellRect(this.col, this.row, this.colSpan, this.rowSpan);
        return rect
            ? { width: rect.width, height: rect.height }
            : { width: this.width, height: this.height };
    }

    _getTallCoverSize(width = this.width, height = this.height) {
        if (width <= 0 || height <= 0) return 180;
        return Math.max(84, Math.min(
            236,
            Math.floor(width - 48),
            Math.floor(height - 212)
        ));
    }

    _getWideTallCoverSize(width = this.width, height = this.height) {
        if (width <= 0 || height <= 0) return 200;
        return Math.max(120, Math.min(
            250,
            Math.floor(width * 0.42),
            Math.floor(height - 112)
        ));
    }

    _getMediumCoverSize(width = this.width, height = this.height) {
        if (width <= 0 || height <= 0) return 112;
        return Math.max(80, Math.min(
            148,
            Math.floor(width * 0.34),
            Math.floor(height - 48)
        ));
    }

    _stopArtworkLoading() {
        if (this._artRetryId) {
            GLib.source_remove(this._artRetryId);
            this._artRetryId = 0;
        }
        this._artCancellable?.cancel();
        this._artCancellable = null;
    }

    _setArtworkSource(artUrl) {
        if (artUrl === this._artworkSource) return;

        this._stopArtworkLoading();
        this._artworkSource = artUrl;
        this._artwork = this._readArtwork(artUrl);

        if (/^https?:\/\//i.test(artUrl ?? '')) {
            this._fetchArtwork(artUrl, 1);
        } else if (artUrl?.startsWith('file://') && !this._artwork) {
            this._startArtworkRetry(artUrl);
        }
    }

    _readArtwork(artUrl) {
        if (!artUrl) return null;
        if (artUrl.startsWith('data:')) return this._readInlineArtwork(artUrl);

        try {
            const file = Gio.File.new_for_uri(artUrl);
            if (!file.has_uri_scheme('file') || !file.query_exists(null)) return null;
            const path = file.get_path();
            const [, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
            if (width <= 0 || height <= 0) return null;
            return {
                gicon: new Gio.FileIcon({ file }),
                aspect: width / height,
            };
        } catch (_error) {
            return null;
        }
    }

    _readInlineArtwork(artUrl) {
        const separator = artUrl.indexOf(',');
        if (separator < 0) return null;

        const header = artUrl.slice(0, separator);
        const payload = artUrl.slice(separator + 1);
        try {
            const data = header.endsWith(';base64')
                ? GLib.base64_decode(payload)
                : new TextEncoder().encode(decodeURIComponent(payload));
            return this._readArtworkBytes(new GLib.Bytes(data));
        } catch (_error) {
            return null;
        }
    }

    _readArtworkBytes(bytes) {
        let width = 0;
        let height = 0;
        const loader = new GdkPixbuf.PixbufLoader();
        loader.connect('size-prepared', (_loader, imageWidth, imageHeight) => {
            width = imageWidth;
            height = imageHeight;
        });

        try {
            const length = bytes.get_size();
            for (let offset = 0; offset < length && width === 0; offset += ART_CHUNK) {
                const chunkLength = Math.min(ART_CHUNK, length - offset);
                loader.write_bytes(GLib.Bytes.new_from_bytes(bytes, offset, chunkLength));
            }
        } catch (_error) {
            width = 0;
        }
        try {
            loader.close();
        } catch (_error) {}

        if (width <= 0 || height <= 0) return null;
        return {
            gicon: new Gio.BytesIcon({ bytes }),
            aspect: width / height,
        };
    }

    _fetchArtwork(artUrl, attempt) {
        const message = Soup.Message.new('GET', artUrl);
        if (!message) return;

        this._artSession ??= new Soup.Session({ timeout: REMOTE_ART_TIMEOUT });
        const cancellable = new Gio.Cancellable();
        this._artCancellable = cancellable;
        this._artSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (session, result) => {
                let artwork = null;
                try {
                    const bytes = session.send_and_read_finish(result);
                    if (message.get_status() === Soup.Status.OK)
                        artwork = this._readArtworkBytes(bytes);
                } catch (_error) {}

                if (cancellable.is_cancelled() || this._artworkSource !== artUrl) return;
                this._artCancellable = null;

                if (artwork || attempt >= REMOTE_ART_TRIES) {
                    this._artwork = artwork;
                    this._render();
                    return;
                }

                this._fetchArtwork(artUrl, attempt + 1);
            }
        );
    }

    _startArtworkRetry(artUrl) {
        let attempts = 0;
        this._artRetryId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            ART_RETRY_INTERVAL,
            () => {
                if (this._artworkSource !== artUrl) {
                    this._artRetryId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                attempts++;
                this._artwork = this._readArtwork(artUrl);
                if (this._artwork || attempts >= ART_RETRIES) {
                    this._artRetryId = 0;
                    this._render();
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _formatTime(seconds) {
        const total = Math.max(0, Math.floor(seconds));
        const minutes = Math.floor(total / 60);
        const remainder = total % 60;
        return `${minutes}:${String(remainder).padStart(2, '0')}`;
    }

    _getCurrentPosition() {
        if (this._currentData.status !== 'Playing') return this._positionAnchor;
        const elapsed = GLib.get_monotonic_time() / 1_000_000 - this._positionAnchorTime;
        const position = this._positionAnchor + elapsed;
        return this._currentData.duration > 0
            ? Math.min(position, this._currentData.duration)
            : position;
    }

    _updateTimeline() {
        const position = this._getCurrentPosition();
        this._currentData.position = position;
        if (this._timelineElapsedLabel) {
            this._timelineElapsedLabel.text = this._formatTime(position);
        }
        if (this._timelineTrack && this._timelineFill) {
            const duration = this._currentData.duration;
            const fraction = duration > 0 ? Math.min(1, position / duration) : 0;
            this._timelineFill.set_size(Math.round(Math.max(0, this._timelineTrack.width) * fraction), 3);
        }
    }

    async _watchPlayers() {
        this._nameOwnerChangedId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _interface, _signal, parameters) => {
                const [name, oldOwner, newOwner] = parameters.deep_unpack();
                if (!name.startsWith(MPRIS_PREFIX)) return;

                if (oldOwner) {
                    const subscriptionId = this._playerSubscriptions.get(name);
                    if (subscriptionId) {
                        Gio.DBus.session.signal_unsubscribe(subscriptionId);
                        this._playerSubscriptions.delete(name);
                    }
                }
                if (newOwner) this._subscribePlayer(name);
                this._discoverPlayer();
            }
        );

        const reply = await this._dbusCall(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'ListNames',
            null
        );
        if (!reply) return;

        const names = reply.deep_unpack()[0] ?? [];
        for (const name of names) {
            if (name.startsWith(MPRIS_PREFIX)) this._subscribePlayer(name);
        }
        this._discoverPlayer();
    }

    _subscribePlayer(playerName) {
        if (this._playerSubscriptions.has(playerName)) return;

        const subscriptionId = Gio.DBus.session.signal_subscribe(
            playerName,
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2.Player',
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _interface, _signal, parameters) => {
                const [changedInterface, changedProperties] = parameters.deep_unpack();
                if (changedInterface !== 'org.mpris.MediaPlayer2.Player') return;
                if (!('Metadata' in changedProperties) && !('PlaybackStatus' in changedProperties)) return;
                this._discoverPlayer();
            }
        );
        this._playerSubscriptions.set(playerName, subscriptionId);
    }

    _dbusCall(busName, objectPath, interfaceName, member, params) {
        return new Promise(resolve => {
            Gio.DBus.session.call(
                busName,
                objectPath,
                interfaceName,
                member,
                params,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (conn, result) => {
                    try {
                        resolve(conn.call_finish(result));
                    } catch (_error) {
                        resolve(null);
                    }
                }
            );
        });
    }

    _unpackVariant(value) {
        if (value instanceof GLib.Variant) {
            return this._unpackVariant(value.deep_unpack());
        }
        if (Array.isArray(value)) {
            return value.map(item => this._unpackVariant(item));
        }
        if (value && Object.getPrototypeOf(value) === Object.prototype) {
            return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [key, this._unpackVariant(item)])
            );
        }
        return value;
    }

    async _discoverPlayer() {
        try {
            const reply = await this._dbusCall(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'ListNames',
                null
            );
            if (!reply) return;

            const names = reply.deep_unpack()[0] ?? [];
            const players = names.filter(n => n.startsWith(MPRIS_PREFIX));
            if (players.length === 0) {
                this._playerName = null;
                this._setIdleState();
                return;
            }

            let chosen = null;
            for (const name of players) {
                const status = await this._getPlayerProperty(name, 'PlaybackStatus');
                if (status === 'Playing') {
                    chosen = name;
                    break;
                }
                if (status && !chosen) chosen = name;
            }
            if (!chosen) {
                this._playerName = null;
                this._setIdleState();
                return;
            }
            this._playerName = chosen;
            await this._updateMetadata();
        } catch (_error) {
            this._setIdleState();
        }
    }

    async _getPlayerProperty(busName, property) {
        try {
            const reply = await this._dbusCall(
                busName,
                '/org/mpris/MediaPlayer2',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', property])
            );
            if (!reply) return null;
            return this._unpackVariant(reply.deep_unpack()[0]);
        } catch (_error) {
            return null;
        }
    }

    async _updateMetadata() {
        if (!this._playerName) {
            this._setIdleState();
            return;
        }

        try {
            const [metadata, status, position] = await Promise.all([
                this._getPlayerProperty(this._playerName, 'Metadata'),
                this._getPlayerProperty(this._playerName, 'PlaybackStatus'),
                this._getPlayerProperty(this._playerName, 'Position'),
            ]);
            if (!metadata) {
                this._setIdleState();
                return;
            }

            const title = metadata['xesam:title'] ?? _('Untitled');
            const artistValue = metadata['xesam:artist'];
            const artist = Array.isArray(artistValue) && artistValue.length > 0
                ? artistValue.join(', ')
                : (typeof artistValue === 'string' ? artistValue : _('Unknown artist'));
            const album = metadata['xesam:album'] ?? '';
            const artUrl = metadata['mpris:artUrl'] ?? '';
            const duration = Math.max(0, Number(metadata['mpris:length'] ?? 0) / 1_000_000);
            const positionSeconds = Math.max(0, Number(position ?? 0) / 1_000_000);

            const playerDisplay = this._playerName.replace(MPRIS_PREFIX, '');
            const previousData = this._currentData;
            const shouldRender = previousData.title !== title ||
                previousData.artist !== artist ||
                previousData.album !== album ||
                previousData.status !== (status ?? '') ||
                previousData.playerName !== playerDisplay ||
                previousData.artUrl !== artUrl ||
                previousData.duration !== duration;

            this._currentData = {
                title,
                artist,
                album,
                status: status ?? '',
                playerName: playerDisplay,
                artUrl,
                position: Math.min(positionSeconds, duration || positionSeconds),
                duration,
            };
            this._setArtworkSource(artUrl);
            this._positionAnchor = this._currentData.position;
            this._positionAnchorTime = GLib.get_monotonic_time() / 1_000_000;
            if (shouldRender) this._render();
            else this._updateTimeline();
        } catch (_error) {
            this._setIdleState();
        }
    }

    _setIdleState() {
        this._setArtworkSource('');
        this._currentData = {
            title: _('Nothing playing'),
            artist: _('Open a compatible player'),
            album: '',
            status: '',
            playerName: '',
            artUrl: '',
            position: 0,
            duration: 0,
        };
        this._positionAnchor = 0;
        this._positionAnchorTime = GLib.get_monotonic_time() / 1_000_000;
        this._render();
    }

    _callPlayerMethod(method) {
        if (!this._playerName) return;
        Gio.DBus.session.call(
            this._playerName,
            '/org/mpris/MediaPlayer2',
            'org.mpris.MediaPlayer2.Player',
            method,
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            null
        );
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            this._updateMetadata();
            return GLib.SOURCE_REMOVE;
        });
    }

    
    _buildCoverActor(artUrl, size = 78) {
        const isLarge = size >= 140;
        const coverBox = new St.Widget({
            style_class: isLarge
                ? 'widget-media-cover-large'
                : 'widget-media-cover',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });
        coverBox.set_size(size, size);
        coverBox.add_effect(new CoverClipEffect());

        const artwork = artUrl === this._artworkSource ? this._artwork : null;
        const artActor = artwork?.gicon ? new St.Icon({
            gicon: artwork.gicon,
            icon_size: size,
            style_class: 'widget-media-art-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }) : null;

        if (artActor) {
            coverBox.add_child(artActor);
            artActor.set_position(0, 0);
        } else {
            const iconSize = Math.round(size * 0.42);
            const artActor = createIcon('music', iconSize, 'widget-media-art-icon');
            artActor.x_align = Clutter.ActorAlign.CENTER;
            artActor.y_align = Clutter.ActorAlign.CENTER;
            coverBox.add_child(artActor);
            const halfSize = size / 2;
            const halfIcon = iconSize / 2;
            artActor.set_position(Math.round(halfSize - halfIcon), Math.round(halfSize - halfIcon));
        }

        return coverBox;
    }

    _createControls(status, isLarge = false) {
        const controls = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: isLarge ? 'widget-media-controls-large' : 'widget-media-controls',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const prevButton = new St.Button({
            style_class: 'widget-media-button',
            child: createIcon('player-skip-back', 15, 'widget-media-button-icon'),
            reactive: true,
            can_focus: true,
        });
        const playButton = new St.Button({
            style_class: isLarge
                ? 'widget-media-button widget-media-play-button widget-media-play-large'
                : 'widget-media-button widget-media-play-button',
            child: createIcon(status === 'Playing' ? 'player-pause' : 'player-play', 18, 'widget-media-button-icon'),
            reactive: true,
            can_focus: true,
        });
        const nextButton = new St.Button({
            style_class: 'widget-media-button',
            child: createIcon('player-skip-forward', 15, 'widget-media-button-icon'),
            reactive: true,
            can_focus: true,
        });

        prevButton.connect('clicked', () => this._callPlayerMethod('Previous'));
        playButton.connect('clicked', () => this._callPlayerMethod('PlayPause'));
        nextButton.connect('clicked', () => this._callPlayerMethod('Next'));

        controls.add_child(prevButton);
        controls.add_child(playButton);
        controls.add_child(nextButton);
        return controls;
    }

    _createTimeline(position, duration) {
        const progress = duration > 0 ? Math.min(1, position / duration) : 0;
        const timeline = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'widget-media-timeline',
            x_expand: true,
        });
        const times = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'widget-media-times',
            x_expand: true,
        });
        const elapsed = new St.Label({
            text: this._formatTime(position),
            style_class: 'widget-media-time',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        const total = new St.Label({
            text: duration > 0 ? this._formatTime(duration) : '--:--',
            style_class: 'widget-media-time',
            x_align: Clutter.ActorAlign.END,
        });
        times.add_child(elapsed);
        times.add_child(total);

        const track = new St.Widget({
            style_class: 'widget-media-progress-track',
            x_expand: true,
        });
        const fill = new St.Widget({ style_class: 'widget-media-progress-fill' });
        track.add_child(fill);
        const updateFill = () => {
            fill.set_size(Math.round(Math.max(0, track.width) * progress), 3);
        };
        track.connect('notify::allocation', updateFill);
        this._timelineElapsedLabel = elapsed;
        this._timelineTrack = track;
        this._timelineFill = fill;
        timeline.add_child(times);
        timeline.add_child(track);
        updateFill();
        return timeline;
    }

    _render() {
        const tier = this.sizeTier;
        const isTall = this.rowSpan >= 3;
        const isWideTall = this.colSpan >= 4 && this.rowSpan === 3;
        const { width, height } = this._getTargetSize();
        const coverSize = isWideTall
            ? this._getWideTallCoverSize(width, height)
            : isTall
                ? this._getTallCoverSize(width, height)
                : tier === 'medium' ? this._getMediumCoverSize(width, height) : '';
        const key = `${tier}-${isWideTall ? 'wide-tall' : isTall ? 'tall' : 'flat'}-${coverSize}`;
        this._lastRenderedKey = key;
        this._lastRenderedLayoutKey = `${tier}-${isWideTall ? 'wide-tall' : isTall ? 'tall' : 'flat'}`;
        const data = this._currentData;
        const isSmall = tier === 'small' && !isTall;
        const statusLabels = {
            Playing: _('Playing'),
            Paused: _('Paused'),
            Stopped: _('Stopped'),
        };

        this._card.destroy_all_children();
        if (isSmall) {
            this._card.add_style_class_name('widget-media-cover-mode');
            this._card.set_style('padding: 0; background-color: #202024;');
        } else {
            this._card.remove_style_class_name('widget-media-cover-mode');
            this._card.set_style(null);
        }

        const contentBox = new St.BoxLayout({
            style_class: 'widget-content-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'widget-header',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const equalizer = new EqualizerBars();
        equalizer.setPlaying(data.status === 'Playing');

        const playerTag = new St.Label({
            text: (data.playerName || '').toUpperCase(),
            style_class: 'widget-caption',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const statusLabel = new St.Label({
            text: statusLabels[data.status] ?? data.status,
            style_class: 'widget-header-side',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (!isSmall) {
            header.add_child(equalizer);
            if (data.playerName) {
                header.add_child(playerTag);
            }
            header.add_child(statusLabel);
            contentBox.add_child(header);
        }

        if (isTall) {
            const cover = this._buildCoverActor(data.artUrl, coverSize);

            const infoBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_align: isWideTall ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
                x_expand: true,
                style_class: 'widget-media-info-box',
            });

            if (data.playerName) {
                const playerLabel = new St.Label({
                    text: data.playerName.toUpperCase(),
                    style_class: 'widget-media-player-badge',
                    x_align: Clutter.ActorAlign.CENTER,
                });
                infoBox.add_child(playerLabel);
            }

            const titleLabel = new St.Label({
                text: data.title,
                style_class: isWideTall
                    ? 'widget-media-title-large widget-media-wide-title'
                    : 'widget-media-title-large',
                x_align: isWideTall ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            titleLabel.clutter_text.line_wrap = false;

            const artistLabel = new St.Label({
                text: data.album ? `${data.artist} · ${data.album}` : data.artist,
                style_class: 'widget-media-artist-large',
                x_align: isWideTall ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            artistLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

            infoBox.add_child(titleLabel);
            infoBox.add_child(artistLabel);

            const timeline = this._createTimeline(data.position, data.duration);
            const controls = this._createControls(data.status, true);
            controls.x_align = Clutter.ActorAlign.CENTER;

            if (isWideTall) {
                const splitRow = new St.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL,
                    style_class: 'widget-media-wide-row',
                    x_expand: true,
                    y_expand: true,
                    x_align: Clutter.ActorAlign.FILL,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const infoColumn = new St.BoxLayout({
                    orientation: Clutter.Orientation.VERTICAL,
                    style_class: 'widget-media-wide-info',
                    x_expand: true,
                    y_expand: true,
                    x_align: Clutter.ActorAlign.FILL,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const spacer = new St.Widget({ y_expand: true });
                cover.y_align = Clutter.ActorAlign.CENTER;
                infoColumn.add_child(infoBox);
                infoColumn.add_child(timeline);
                infoColumn.add_child(spacer);
                infoColumn.add_child(controls);
                splitRow.add_child(cover);
                splitRow.add_child(infoColumn);
                contentBox.add_child(splitRow);
            } else {
                const spacerBottom = new St.Widget({ y_expand: true });
                cover.x_align = Clutter.ActorAlign.CENTER;
                cover.y_align = Clutter.ActorAlign.CENTER;
                contentBox.add_child(cover);
                contentBox.add_child(infoBox);
                contentBox.add_child(timeline);
                contentBox.add_child(spacerBottom);
                contentBox.add_child(controls);
            }

        } else if (tier === 'medium') {
            const splitRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const coverBox = this._buildCoverActor(data.artUrl, this._getMediumCoverSize(width, height));

            const infoCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            if (data.playerName) {
                infoCol.add_child(new St.Label({
                    text: data.playerName.toUpperCase(),
                    style_class: 'widget-media-player-badge',
                }));
            }

            const titleLabel = new St.Label({
                text: data.title,
                style_class: 'widget-media-title widget-media-medium-title',
            });
            titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

            const artistLabel = new St.Label({
                text: data.album ? `${data.artist} · ${data.album}` : data.artist,
                style_class: 'widget-media-artist-medium',
            });
            artistLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

            infoCol.add_child(titleLabel);
            infoCol.add_child(artistLabel);
            infoCol.add_child(this._createControls(data.status, false));

            splitRow.add_child(coverBox);
            splitRow.add_child(infoCol);
            contentBox.add_child(splitRow);

        } else {
            const spacer = new St.Widget({ y_expand: true });
            const overlay = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-media-small-overlay',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            const titleRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const smallEq = new EqualizerBars({ width: 14, height: 11 });
            smallEq.setPlaying(data.status === 'Playing');
            const smallTitleLabel = new St.Label({
                text: data.title,
                style_class: 'widget-media-small-title',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            smallTitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            smallTitleLabel.clutter_text.line_wrap = false;

            const smallArtistLabel = new St.Label({
                text: data.album ? `${data.artist} · ${data.album}` : data.artist,
                style_class: 'widget-media-small-artist',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            smallArtistLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            smallArtistLabel.clutter_text.line_wrap = false;

            titleRow.add_child(smallTitleLabel);
            titleRow.add_child(smallEq);

            overlay.add_child(titleRow);
            overlay.add_child(smallArtistLabel);
            const controls = this._createControls(data.status, false);
            controls.add_style_class_name('widget-media-small-controls');
            overlay.add_child(controls);
            contentBox.add_child(spacer);
            contentBox.add_child(overlay);
        }

        if (isSmall && this._artwork?.gicon && data.artUrl === this._artworkSource) {
            const cover = new St.Widget({
                style_class: 'widget-media-cover-full',
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
                clip_to_allocation: true,
            });
            cover.add_effect(new CoverClipEffect());
            cover.add_child(new St.Icon({
                gicon: this._artwork.gicon,
                icon_size: Math.max(this.width, this.height, 180),
                style_class: 'widget-media-art-icon',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
            }));
            this._card.add_child(cover);
        }
        this._card.add_child(contentBox);
    }
});

export const WIDGET_CONFIG = { colSpan: 4, rowSpan: 3, minColSpan: 2, maxColSpan: 6, minRowSpan: 2, maxRowSpan: 4 };
export const WIDGET_NAME = _('Music');
export const WIDGET_DESCRIPTION = _('Playback controls and large album artwork.');
