import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

const NATIVE_ICON_MAP = {
    battery: 'battery-symbolic',
    database: 'drive-harddisk-symbolic',
    music: 'audio-x-generic-symbolic',
    'player-skip-back': 'media-skip-backward-symbolic',
    'player-pause': 'media-playback-pause-symbolic',
    'player-play': 'media-playback-start-symbolic',
    'player-skip-forward': 'media-skip-forward-symbolic',
    wifi: 'network-wireless-symbolic',
    notebook: 'accessories-text-editor-symbolic',
    cpu: 'utilities-system-monitor-symbolic',
    cloud: 'weather-cloud-symbolic',
    sun: 'weather-clear-symbolic',
    rain: 'weather-showers-symbolic',
    storm: 'weather-storm-symbolic',
    moon: 'weather-clear-night-symbolic',
    fog: 'weather-fog-symbolic',
    snow: 'weather-snow-symbolic',
    wind: 'weather-windy-symbolic',
    'cloud-rain': 'weather-showers-symbolic',
    'cloud-sun': 'weather-few-clouds-symbolic',
    'cloud-moon': 'weather-few-clouds-night-symbolic',
    'cloud-fog': 'weather-fog-symbolic',
};

export function getWidgetIcon(name) {
    const key = String(name ?? '').trim().toLowerCase();
    const iconName = NATIVE_ICON_MAP[key] ?? `${key}-symbolic`;
    return new Gio.ThemedIcon({ name: iconName });
}

export function createIcon(name, size = 16, styleClass = 'widget-header-icon') {
    return new St.Icon({
        gicon: getWidgetIcon(name),
        icon_size: size,
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
    });
}