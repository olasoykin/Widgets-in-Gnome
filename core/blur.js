import Shell from 'gi://Shell';
import St from 'gi://St';

export const SUPPORTS_CORNER_RADIUS = Boolean(
    Shell.BlurEffect?.list_properties().some(property => property.name === 'corner-radius')
);


export class BlurManager {
    constructor(actor, options = {}) {
        this.actor = actor;
        this.cornerRadius = options.cornerRadius ?? 24;
        this.effect = null;
        this._isBmsEffect = false;
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._settingsSignals = [];
        this._main = null;
        this._extChangedId = null;
        this._destroyed = false;

        import('resource:///org/gnome/shell/ui/main.js').then(Main => {
            if (this._destroyed) return;
            this._main = Main;
            this._extChangedId = Main.extensionManager?.connect(
                'extension-state-changed',
                (mgr, ext) => {
                    if (ext.uuid === 'blur-my-shell@aunetx') {
                        this.refresh();
                    }
                }
            );
        }).catch(error => {
            console.warn('[Widgets Blur] No se pudo observar el estado de extensiones:', error);
        });

        this.apply();
    }

    get hasBlurMyShell() {
        return Boolean(global.blur_my_shell && global.blur_my_shell._effects_manager);
    }

    apply() {
        this.remove();

        const bms = global.blur_my_shell;
        if (bms && bms._effects_manager) {
            const sigma = bms._settings?.SIGMA ?? 30;
            const brightness = bms._settings?.BRIGHTNESS ?? 0.65;

            try {
                this.effect = bms._effects_manager.new_native_dynamic_gaussian_blur_effect({
                    unscaled_radius: sigma,
                    brightness: brightness,
                    unscaled_corner_radius: this.cornerRadius,
                });
                this._isBmsEffect = true;
                this.actor.add_effect(this.effect);

                if (bms._settings?.settings) {
                    const id1 = bms._settings.settings.connect('changed::sigma', () => {
                        if (this.effect && this._isBmsEffect) {
                            this.effect.unscaled_radius = bms._settings.SIGMA;
                        }
                    });
                    const id2 = bms._settings.settings.connect('changed::brightness', () => {
                        if (this.effect && this._isBmsEffect) {
                            this.effect.brightness = bms._settings.BRIGHTNESS;
                        }
                    });
                    this._settingsSignals.push(id1, id2);
                }
                return;
            } catch (err) {
                console.warn('[Widgets Blur] Error al aplicar efecto de Blur my Shell:', err);
                this._isBmsEffect = false;
            }
        }

        try {
            const scaleFactor = this._themeContext.scale_factor;
            this.effect = new Shell.BlurEffect({
                mode: Shell.BlurMode.BACKGROUND,
            });
            this.effect.radius = Math.max(0, 30 * scaleFactor);
            this.effect.brightness = 0.65;
            if (SUPPORTS_CORNER_RADIUS) {
                this.effect.corner_radius = Math.max(0, this.cornerRadius * scaleFactor);
            }

            this._scaleSignalId = this._themeContext.connect('notify::scale-factor', () => {
                if (this.effect && !this._isBmsEffect) {
                    const factor = this._themeContext.scale_factor;
                    this.effect.radius = Math.max(0, 30 * factor);
                    if (SUPPORTS_CORNER_RADIUS) {
                        this.effect.corner_radius = Math.max(0, this.cornerRadius * factor);
                    }
                }
            });

            this.actor.add_effect(this.effect);
        } catch (err) {
            console.warn('[Widgets Blur] Error al aplicar desenfoque nativo:', err);
        }
    }

    refresh() {
        this.apply();
    }

    remove() {
        this._disconnectSettings();

        if (this._scaleSignalId) {
            this._themeContext.disconnect(this._scaleSignalId);
            this._scaleSignalId = null;
        }

        if (this.effect) {
            const bms = global.blur_my_shell;
            if (this._isBmsEffect && bms && bms._effects_manager) {
                try {
                    bms._effects_manager.remove(this.effect);
                } catch (e) {
                    this.actor.remove_effect(this.effect);
                }
            } else {
                this.actor.remove_effect(this.effect);
            }
            this.effect = null;
            this._isBmsEffect = false;
        }
    }

    _disconnectSettings() {
        const bms = global.blur_my_shell;
        if (bms?._settings?.settings && this._settingsSignals.length > 0) {
            for (const id of this._settingsSignals) {
                try {
                    bms._settings.settings.disconnect(id);
                } catch (e) {}
            }
        }
        this._settingsSignals = [];
    }

    destroy() {
        this._destroyed = true;
        this.remove();
        if (this._extChangedId && this._main?.extensionManager) {
            this._main.extensionManager.disconnect(this._extChangedId);
            this._extChangedId = null;
        }
        this._main = null;
    }
}
