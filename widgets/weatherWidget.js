import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';

const WEATHER_CONDITIONS = {
    0: { text: _('Clear'), icon: 'sun' },
    1: { text: _('Mostly clear'), icon: 'sun' },
    2: { text: _('Partly cloudy'), icon: 'cloud-sun' },
    3: { text: _('Cloudy'), icon: 'cloud' },
    45: { text: _('Fog'), icon: 'fog' },
    48: { text: _('Rime fog'), icon: 'fog' },
    51: { text: _('Light drizzle'), icon: 'cloud-rain' },
    53: { text: _('Drizzle'), icon: 'cloud-rain' },
    55: { text: _('Heavy drizzle'), icon: 'cloud-rain' },
    56: { text: _('Freezing drizzle'), icon: 'cloud-rain' },
    57: { text: _('Freezing drizzle'), icon: 'cloud-rain' },
    61: { text: _('Light rain'), icon: 'cloud-rain' },
    63: { text: _('Rain'), icon: 'cloud-rain' },
    65: { text: _('Heavy rain'), icon: 'cloud-rain' },
    66: { text: _('Freezing rain'), icon: 'cloud-rain' },
    67: { text: _('Freezing rain'), icon: 'cloud-rain' },
    71: { text: _('Light snow'), icon: 'snow' },
    73: { text: _('Snow'), icon: 'snow' },
    75: { text: _('Heavy snow'), icon: 'snow' },
    77: { text: _('Snow grains'), icon: 'snow' },
    80: { text: _('Light showers'), icon: 'cloud-rain' },
    81: { text: _('Showers'), icon: 'cloud-rain' },
    82: { text: _('Heavy showers'), icon: 'cloud-rain' },
    85: { text: _('Snow showers'), icon: 'snow' },
    86: { text: _('Snow showers'), icon: 'snow' },
    95: { text: _('Thunderstorm'), icon: 'storm' },
    96: { text: _('Thunderstorm with hail'), icon: 'storm' },
    99: { text: _('Heavy thunderstorm'), icon: 'storm' },
};

function _getWeatherIconName(icon, isDay = 1) {
    if (isDay === 0) {
        if (icon === 'sun') return 'moon';
        if (icon === 'cloud-sun') return 'cloud-moon';
    }
    return icon;
}

const LOCATION_CACHE_MAX_AGE_SECONDS = 24 * 60 * 60;
const WEATHER_REFRESH_SECONDS = 30 * 60;

export const Widget = GObject.registerClass(
class WeatherWidget extends BaseWidget {
    _init(params = {}) {
        super._init({
            ...params,
            colSpan: params.colSpan ?? 2,
            rowSpan: params.rowSpan ?? 2,
        });

        this._session = new Soup.Session();
        this._cancellable = new Gio.Cancellable();
        this._location = null;
        this._weatherData = null;
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

        this._renderEmpty(_('Loading weather…'));
        this._loadLocation();

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            WEATHER_REFRESH_SECONDS,
            () => {
                this._fetchWeather();
                return GLib.SOURCE_CONTINUE;
            }
        );

        this.connect('destroy', () => {
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
            this._cancellable.cancel();
            if (this._session) {
                this._session.abort();
                this._session = null;
            }
        });
    }

    onGeometryChanged() {
        if (this._weatherData && this._lastRenderedTier !== this.sizeTier) {
            this._renderWeather();
            this.refreshAdaptiveLabels();
        }
    }

    _getConfigPath() {
        return GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'widgets@kin',
            'location.json',
        ]);
    }

    _loadCachedLocation() {
        try {
            const [, contents] = GLib.file_get_contents(this._getConfigPath());
            const cached = JSON.parse(new TextDecoder().decode(contents));
            const ageSeconds = (GLib.get_real_time() / 1000) - (cached.fetchedAt ?? 0);
            if (Number.isFinite(cached.latitude) && Number.isFinite(cached.longitude) &&
                ageSeconds < LOCATION_CACHE_MAX_AGE_SECONDS) {
                return cached;
            }
        } catch (_error) {
        }
        return null;
    }

    _saveCachedLocation(location) {
        try {
            const path = this._getConfigPath();
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
            GLib.file_set_contents(path, JSON.stringify({
                ...location,
                fetchedAt: GLib.get_real_time() / 1000,
            }));
        } catch (error) {
            console.warn(`[Widgets] No se pudo guardar la ubicación: ${error.message}`);
        }
    }

    _loadLocation() {
        const cached = this._loadCachedLocation();
        if (cached) {
            this._location = cached;
            this._fetchWeather();
            return;
        }
        this._geolocate();
    }

    _geolocate() {
        const message = Soup.Message.new('GET', 'https://ipwho.is/');
        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (session, result) => {
                let payload;
                try {
                    const bytes = session.send_and_read_finish(result);
                    payload = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                } catch (_error) {
                    this._renderEmpty(_('No connection'));
                    return;
                }

                if (!payload?.success || !Number.isFinite(payload.latitude) ||
                    !Number.isFinite(payload.longitude)) {
                    this._renderEmpty(_('Location unavailable'));
                    return;
                }

                this._location = {
                    latitude: payload.latitude,
                    longitude: payload.longitude,
                    city: payload.city ?? '',
                };
                this._saveCachedLocation(this._location);
                this._fetchWeather();
            }
        );
    }

    _fetchWeather() {
        if (!this._location) {
            this._geolocate();
            return;
        }

        const url =
            'https://api.open-meteo.com/v1/forecast' +
            `?latitude=${this._location.latitude}` +
            `&longitude=${this._location.longitude}` +
            '&current=temperature_2m,relative_humidity_2m,apparent_temperature,' +
            'is_day,weather_code,wind_speed_10m' +
            '&hourly=temperature_2m,weather_code,is_day,precipitation_probability' +
            '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max' +
            '&timezone=auto&forecast_days=5';

        const message = Soup.Message.new('GET', url);
        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (session, result) => {
                let payload;
                try {
                    const bytes = session.send_and_read_finish(result);
                    payload = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                } catch (_error) {
                    this._renderEmpty(_('No connection'));
                    return;
                }

                const current = payload?.current;
                const daily = payload?.daily;
                const hourly = payload?.hourly;
                if (!current || !daily) {
                    this._renderEmpty(_('No data'));
                    return;
                }

                this._weatherData = { current, daily, hourly };
                this._renderWeather();
                this.refreshAdaptiveLabels();
            }
        );
    }

    _renderEmpty(message) {
        this._card.destroy_all_children();
        const contentBox = new St.BoxLayout({
            style_class: 'widget-content-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const header = this._createHeader('cloud', this._location?.city ?? '');
        const tempLabel = new St.Label({
            text: '—',
            style_class: 'widget-common-value',
            x_align: Clutter.ActorAlign.START,
        });
        const msgLabel = new St.Label({
            text: message,
            style_class: 'widget-common-detail',
            x_align: Clutter.ActorAlign.START,
        });

        contentBox.add_child(header);
        contentBox.add_child(tempLabel);
        contentBox.add_child(msgLabel);
        this._card.add_child(contentBox);
    }

    _createHeader(iconName, cityText) {
        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'widget-header',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const locationLabel = new St.Label({
            text: cityText || _('Local'),
            style_class: 'widget-title',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        });
        const icon = createIcon(iconName, 18, 'widget-weather-header-icon');
        header.add_child(locationLabel);
        header.add_child(icon);
        return header;
    }

    _buildHourlyForecast(current, hourly, count = 5) {
        const hourlyBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'widget-weather-hourly-box',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (!hourly?.time || hourly.time.length === 0) return hourlyBox;

        const currentIsoHour = current.time ? current.time.slice(0, 13) : '';
        let startIdx = hourly.time.findIndex(t => t.startsWith(currentIsoHour));
        if (startIdx < 0) startIdx = 0;

        for (let i = 0; i < count; i++) {
            const idx = startIdx + i;
            if (idx >= hourly.time.length) break;

            const t = hourly.time[idx];
            const isDay = hourly.is_day ? hourly.is_day[idx] : 1;
            const code = hourly.weather_code ? hourly.weather_code[idx] : 0;
            const tempVal = Math.round(hourly.temperature_2m[idx]);
            const precipitation = hourly.precipitation_probability?.[idx] ?? 0;
            const cond = WEATHER_CONDITIONS[code] ?? { icon: 'cloud' };

            const iconName = _getWeatherIconName(cond.icon, isDay);

            let timeLabelText = _('Now');
            if (i > 0) {
                timeLabelText = t.slice(11, 16);
            }

            const col = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-weather-hourly-col',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const timeLabel = new St.Label({
                text: timeLabelText,
                style_class: 'widget-weather-hourly-time',
                x_align: Clutter.ActorAlign.CENTER,
            });
            const icon = createIcon(iconName, 18);
            icon.x_align = Clutter.ActorAlign.CENTER;

            const tempLabel = new St.Label({
                text: `${tempVal}°`,
                style_class: 'widget-weather-hourly-temp',
                x_align: Clutter.ActorAlign.CENTER,
            });

            col.add_child(timeLabel);
            col.add_child(icon);
            if (precipitation > 0) {
                col.add_child(new St.Label({
                    text: `${precipitation}%`,
                    style_class: 'widget-weather-precipitation',
                    x_align: Clutter.ActorAlign.CENTER,
                }));
            }
            col.add_child(tempLabel);
            hourlyBox.add_child(col);
        }

        return hourlyBox;
    }

    _buildDailyForecast(daily, count = 3) {
        const dailyBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'widget-weather-daily-box',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });

        if (!daily?.time) return dailyBox;

        for (let i = 1; i <= count; i++) {
            if (i >= daily.time.length) break;

            const dateStr = daily.time[i];
            const code = daily.weather_code ? daily.weather_code[i] : 0;
            const max = Math.round(daily.temperature_2m_max[i]);
            const min = Math.round(daily.temperature_2m_min[i]);
            const precipitation = daily.precipitation_probability_max?.[i] ?? 0;
            const cond = WEATHER_CONDITIONS[code] ?? { icon: 'cloud' };

            let dayName = dateStr;
            try {
                const dt = GLib.DateTime.new_from_iso8601(`${dateStr}T12:00:00Z`, null);
                if (dt) {
                    const date = new Date(`${dateStr}T12:00:00Z`);
                    dayName = dt.format('%a') ?? dateStr;
                }
            } catch {}

            const row = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-weather-daily-row',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const dayLabel = new St.Label({
                text: dayName.toUpperCase(),
                style_class: 'widget-weather-daily-day',
                x_align: Clutter.ActorAlign.START,
            });
            const icon = createIcon(cond.icon, 14);
            const rangeLabel = new St.Label({
                text: `${_('Min')} ${min}°  ·  ${_('Max')} ${max}°`,
                style_class: 'widget-weather-daily-range',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
            });

            row.add_child(dayLabel);
            row.add_child(icon);
            if (precipitation > 0) {
                row.add_child(new St.Label({
                    text: `${precipitation}%`,
                    style_class: 'widget-weather-precipitation',
                }));
            }
            row.add_child(rangeLabel);
            dailyBox.add_child(row);
        }

        return dailyBox;
    }

    _renderWeather() {
        if (!this._weatherData) return;
        const { current, daily, hourly } = this._weatherData;
        const tier = this.sizeTier;
        this._lastRenderedTier = tier;

        const condition = WEATHER_CONDITIONS[current.weather_code] ??
            { text: _('No description'), icon: 'cloud' };

        const temp = Math.round(current.temperature_2m);
        const feels = Math.round(current.apparent_temperature);
        const max = Math.round(daily.temperature_2m_max?.[0] ?? temp);
        const min = Math.round(daily.temperature_2m_min?.[0] ?? temp);
        const humidity = current.relative_humidity_2m;
        const wind = Math.round(current.wind_speed_10m);
        const city = this._location?.city ?? '';

        const headerIconName = _getWeatherIconName(condition.icon, current.is_day);

        this._card.destroy_all_children();

        const contentBox = new St.BoxLayout({
            style_class: 'widget-content-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const header = this._createHeader(headerIconName, city);
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

            const leftCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const tempLabel = new St.Label({
                text: `${temp}°`,
                style_class: 'widget-common-value',
                x_align: Clutter.ActorAlign.START,
            });
            const conditionLabel = new St.Label({
                text: condition.text,
                style_class: 'widget-common-detail',
                x_align: Clutter.ActorAlign.START,
            });
            const rangeLabel = new St.Label({
                text: `${_('Max')} ${max}° · ${_('Min')} ${min}°`,
                style_class: 'widget-weather-range',
                x_align: Clutter.ActorAlign.START,
            });
            const feelsLabel = new St.Label({
                text: `${_('Feels like')} ${feels}°`,
                style_class: 'widget-weather-details',
                x_align: Clutter.ActorAlign.START,
            });
            const humidityLabel = new St.Label({
                text: `${_('Humidity')} ${humidity}%`,
                style_class: 'widget-weather-details',
                x_align: Clutter.ActorAlign.START,
            });

            leftCol.add_child(tempLabel);
            leftCol.add_child(conditionLabel);
            leftCol.add_child(rangeLabel);
            leftCol.add_child(feelsLabel);
            leftCol.add_child(humidityLabel);

            const rightCol = this._buildHourlyForecast(current, hourly, 5);

            splitRow.add_child(leftCol);
            splitRow.add_child(rightCol);
            contentBox.add_child(splitRow);
        } else if (tier === 'large') {
            const topRow = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'widget-split-row',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const leftCol = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });

            const tempLabel = new St.Label({
                text: `${temp}°`,
                style_class: 'widget-common-value',
                x_align: Clutter.ActorAlign.START,
            });
            const conditionLabel = new St.Label({
                text: condition.text,
                style_class: 'widget-common-detail',
                x_align: Clutter.ActorAlign.START,
            });
            const rangeLabel = new St.Label({
                text: `${_('Max')} ${max}° · ${_('Min')} ${min}°`,
                style_class: 'widget-weather-range',
                x_align: Clutter.ActorAlign.START,
            });

            leftCol.add_child(tempLabel);
            leftCol.add_child(conditionLabel);
            leftCol.add_child(rangeLabel);

            const badgesBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'widget-split-col',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const feelsBadge = new St.Label({
                text: `${_('Feels like')} ${feels}°`,
                style_class: 'widget-badge',
            });
            const humidityBadge = new St.Label({
                text: `${_('Humidity')} ${humidity}%`,
                style_class: 'widget-badge',
            });
            const windBadge = new St.Label({
                text: `${_('Wind')} ${wind} km/h`,
                style_class: 'widget-badge',
            });
            badgesBox.add_child(feelsBadge);
            badgesBox.add_child(humidityBadge);
            badgesBox.add_child(windBadge);

            topRow.add_child(leftCol);
            topRow.add_child(badgesBox);
            contentBox.add_child(topRow);

            const hourlyBox = this._buildHourlyForecast(current, hourly, 6);
            contentBox.add_child(hourlyBox);

            if (this.colSpan >= 4 && this.rowSpan >= 4) {
                const dailyBox = this._buildDailyForecast(daily, 3);
                contentBox.add_child(dailyBox);
            }
        } else {
            const tempLabel = new St.Label({
                text: `${temp}°`,
                style_class: 'widget-common-value',
                x_align: Clutter.ActorAlign.START,
            });
            const conditionLabel = new St.Label({
                text: condition.text,
                style_class: 'widget-common-detail',
                x_align: Clutter.ActorAlign.START,
            });
            const rangeLabel = new St.Label({
                text: `${_('Max')} ${max}° · ${_('Min')} ${min}°`,
                style_class: 'widget-weather-range',
                x_align: Clutter.ActorAlign.START,
            });

            contentBox.add_child(tempLabel);
            contentBox.add_child(conditionLabel);
            contentBox.add_child(rangeLabel);
        }

        this._card.add_child(contentBox);
    }
});

export const WIDGET_CONFIG = { colSpan: 2, rowSpan: 2, minColSpan: 2, maxColSpan: 6, minRowSpan: 2, maxRowSpan: 4 };
export const WIDGET_NAME = _('Weather');
export const WIDGET_DESCRIPTION = _('Temperature, hourly forecast, and conditions.');
