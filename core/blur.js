import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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
        this._static = false;
        this._active = false;
        this._staticPending = false;
        this._staticGeneration = 0;
        this._staticGroup = null;
        this._staticBlurActor = null;
        this._staticPipeline = null;
        this._staticBackgroundManagers = [];
        this._staticNativeEffect = null;
        this._staticMonitorIndex = -1;
        this._staticOwner = null;
        this._staticOwnerSignals = [];
        this._staticSettingsSignals = [];
        this._mappedSignalId = 0;
        this._staticRefreshId = 0;
        this._scaleSignalId = 0;

        import('resource:///org/gnome/shell/ui/main.js').then(MainModule => {
            if (this._destroyed) return;
            this._main = MainModule;
            this._extChangedId = MainModule.extensionManager?.connect(
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

    get isStatic() {
        return this._static;
    }

    get isActive() {
        return this._active || this._staticPending || Boolean(this._mappedSignalId);
    }

    apply() {
        this.remove();

        if (this._static) {
            this._applyStatic(this._staticGeneration);
            return;
        }

        const bms = global.blur_my_shell;
        if (bms && bms._effects_manager) {
            const sigma = bms._settings?.SIGMA ?? 30;
            const brightness = bms._settings?.BRIGHTNESS ?? 0.65;

            try {
                this.effect = bms._effects_manager.new_native_dynamic_gaussian_blur_effect({
                    unscaled_radius: sigma,
                    brightness,
                    unscaled_corner_radius: this.cornerRadius,
                });
                this._isBmsEffect = true;
                this.actor.add_effect(this.effect);
                this._active = true;

                if (bms._settings?.settings) {
                    this._connectBmsSettings(bms);
                }
                return;
            } catch (err) {
                console.warn('[Widgets Blur] Error al aplicar efecto de Blur my Shell:', err);
                this._isBmsEffect = false;
            }
        }

        try {
            const scaleFactor = this._themeContext.scale_factor;
            this.effect = new Shell.BlurEffect({ mode: Shell.BlurMode.BACKGROUND });
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
            this._active = true;
        } catch (err) {
            console.warn('[Widgets Blur] Error al aplicar desenfoque nativo:', err);
        }
    }

    refresh() {
        this.apply();
    }

    setStatic(enabled, apply = true) {
        const next = Boolean(enabled);
        if (this._static === next) return false;
        this._static = next;
        if (apply) this.apply();
        return true;
    }

    raiseOwnerAndStaticLayer() {
        const owner = this._staticOwner ?? this.actor.get_parent();
        const sceneParent = owner?.get_parent();
        if (!owner || !sceneParent) return false;

        sceneParent.set_child_above_sibling(owner, null);
        if (this._staticGroup?.get_parent() === sceneParent) {
            sceneParent.set_child_below_sibling(this._staticGroup, owner);
        }
        return true;
    }

    scheduleStaticRefresh() {
        if (!this._static || this._destroyed || !this._staticBlurActor) return;
        if (this._staticRefreshId) return;

        this._staticRefreshId = global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW,
            () => {
                this._staticRefreshId = 0;
                if (!this._static || this._destroyed || !this._staticBlurActor) {
                    return GLib.SOURCE_REMOVE;
                }

                const monitor = Main.layoutManager.findMonitorForActor(this._staticOwner);
                if (monitor && monitor.index !== this._staticMonitorIndex) {
                    this.apply();
                } else {
                    this._syncStaticGeometry();
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    async _applyStatic(generation) {
        this._staticPending = true;

        try {
            const bms = global.blur_my_shell;
            const Pipeline = await this._loadBmsPipeline(bms);
            if (!this._isCurrentStaticRequest(generation)) return;

            const owner = this.actor.get_parent();
            if (!owner || !this.actor.get_stage() || owner.width <= 0 || owner.height <= 0) {
                this._waitForMapped(generation);
                return;
            }

            const monitor = Main.layoutManager.findMonitorForActor(owner) ??
                Main.layoutManager.primaryMonitor;
            if (!monitor) throw new Error('No hay un monitor disponible para el blur estático.');

            try {
                if (!Pipeline || !bms?._effects_manager || !bms?._pipelines_manager) {
                    throw new Error('Blur my Shell no tiene disponible su canal de blur estático.');
                }
                this._createBmsStaticLayer(owner, monitor, bms, Pipeline);
            } catch (error) {
                console.warn('[Widgets Blur] No se pudo iniciar el canal estático de Blur my Shell; se usará el blur nativo:', error);
                this._destroyStaticLayer();
                this._createNativeStaticLayer(owner, monitor);
            }

            this._staticOwner = owner;
            this._staticMonitorIndex = monitor.index;
            this._connectStaticGeometry(owner);
            this._syncStaticGeometry();
            this._active = true;
            this.actor.remove_style_class_name('static-blur-fallback');
        } catch (error) {
            if (this._isCurrentStaticRequest(generation)) {
                this._destroyStaticLayer();
                console.warn('[Widgets Blur] No se pudo aplicar el blur estático:', error);
                this._useStaticFallback();
            }
        } finally {
            if (generation === this._staticGeneration) this._staticPending = false;
        }
    }

    async _loadBmsPipeline(bms) {
        if (!bms?._effects_manager || !bms?._pipelines_manager) return null;
        const extensionPath = bms.dir?.get_path?.() ?? bms.path;
        if (!extensionPath) return null;

        const modulePath = GLib.build_filenamev([
            extensionPath,
            'conveniences',
            'pipeline.js',
        ]);
        try {
            const moduleUri = Gio.File.new_for_path(modulePath).get_uri();
            const module = await import(moduleUri);
            return module.Pipeline ?? null;
        } catch (error) {
            console.warn('[Widgets Blur] No se pudo cargar el canal estático de Blur my Shell:', error);
            return null;
        }
    }

    _isCurrentStaticRequest(generation) {
        return !this._destroyed && this._static && generation === this._staticGeneration;
    }

    _waitForMapped(generation) {
        if (this._mappedSignalId) return;
        this._mappedSignalId = this.actor.connect('notify::mapped', () => {
            if (!this.actor.mapped || !this._isCurrentStaticRequest(generation)) return;
            this.actor.disconnect(this._mappedSignalId);
            this._mappedSignalId = 0;
            this.apply();
        });
    }

    _createBackgroundGroup(owner) {
        const sceneParent = owner.get_parent();
        if (!sceneParent) throw new Error('No se encontró el contenedor del escritorio.');

        const backgroundGroup = new Meta.BackgroundGroup({
            name: 'widgets-static-blur-background',
            width: 0,
            height: 0,
        });

        // Put the blurred backdrop above the other widgets, then keep its owner
        // above it so the owner's card and information remain crisp.
        sceneParent.set_child_above_sibling(owner, null);
        const siblingIndex = sceneParent.get_children().indexOf(owner);
        sceneParent.insert_child_at_index(backgroundGroup, Math.max(0, siblingIndex));
        this._staticGroup = backgroundGroup;
        return backgroundGroup;
    }

    _createBmsStaticLayer(owner, monitor, bms, Pipeline) {
        const backgroundGroup = this._createBackgroundGroup(owner);
        const pipelineId = bms._settings?.popup?.PIPELINE ?? 'pipeline_default';
        const pipeline = new Pipeline(
            bms._effects_manager,
            bms._pipelines_manager,
            pipelineId
        );
        const backgroundManagers = [];
        this._staticPipeline = pipeline;
        this._staticBackgroundManagers = backgroundManagers;
        const blurActor = pipeline.create_background_with_effects(
            monitor.index,
            backgroundManagers,
            backgroundGroup,
            'widgets-static-blurred-background'
        );

        this._staticPipeline = pipeline;
        this._staticBlurActor = blurActor;
        this._staticBackgroundManagers = backgroundManagers;

        const popupSettings = bms._settings?.popup?.settings;
        if (popupSettings) {
            const id = popupSettings.connect('changed::pipeline', () => {
                if (this._static && !this._destroyed) this.apply();
            });
            this._staticSettingsSignals.push([popupSettings, id]);
        }
    }

    _createNativeStaticLayer(owner, monitor) {
        const backgroundGroup = this._createBackgroundGroup(owner);
        const blurActor = new St.Widget({
            name: 'widgets-static-blurred-background',
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            reactive: false,
        });
        backgroundGroup.add_child(blurActor);

        const backgroundManager = new Background.BackgroundManager({
            container: blurActor,
            monitorIndex: monitor.index,
            controlPosition: false,
        });
        const effect = new Shell.BlurEffect({ mode: Shell.BlurMode.ACTOR });
        effect.radius = Math.max(0.5, 30 * this._themeContext.scale_factor);
        effect.brightness = 0.6;
        blurActor.add_effect(effect);

        this._staticBlurActor = blurActor;
        this._staticBackgroundManagers = [backgroundManager];
        this._staticNativeEffect = effect;
    }

    _connectStaticGeometry(owner) {
        this._staticOwner = owner;
        const refresh = () => this.scheduleStaticRefresh();
        for (const signal of [
            'notify::position', 'notify::size',
            'notify::x', 'notify::y', 'notify::width', 'notify::height',
            'notify::scale-x', 'notify::scale-y',
            'allocation-changed',
        ]) {
            try {
                this._staticOwnerSignals.push([owner, owner.connect(signal, refresh)]);
            } catch (error) {
                // Some older Clutter versions do not expose every transform notification.
            }
        }
        try {
            this._staticOwnerSignals.push([owner, owner.connect('geometry-changed', refresh)]);
        } catch (error) {
            // BaseWidget emits this signal; keep native actors compatible too.
        }
    }

    _syncStaticGeometry() {
        const owner = this._staticOwner;
        const monitor = Main.layoutManager.monitors[this._staticMonitorIndex];
        const blurActor = this._staticBlurActor;
        if (!owner || !monitor || !blurActor) return;

        const [x, y] = owner.get_transformed_position();
        const [width, height] = owner.get_transformed_size();
        const left = Math.max(0, Math.floor(x - monitor.x));
        const top = Math.max(0, Math.floor(y - monitor.y));
        const right = Math.min(monitor.width, Math.ceil(x + width - monitor.x));
        const bottom = Math.min(monitor.height, Math.ceil(y + height - monitor.y));
        const clipWidth = Math.max(0, right - left);
        const clipHeight = Math.max(0, bottom - top);

        if (clipWidth === 0 || clipHeight === 0) {
            blurActor.hide();
            return;
        }

        blurActor.set_clip(left, top, clipWidth, clipHeight);
        blurActor.show();
        this._staticGroup?.show();
    }

    _destroyStaticLayer() {
        this._disconnectStaticGeometry();
        for (const [settings, id] of this._staticSettingsSignals) {
            try {
                settings.disconnect(id);
            } catch (error) {}
        }
        this._staticSettingsSignals = [];

        const backgroundManagers = this._staticBackgroundManagers;
        const blurActor = this._staticBlurActor;
        const pipeline = this._staticPipeline;
        const nativeEffect = this._staticNativeEffect;
        this._staticBackgroundManagers = [];
        this._staticBlurActor = null;
        this._staticPipeline = null;
        this._staticNativeEffect = null;

        if (pipeline) {
            pipeline.destroy();
            for (const manager of backgroundManagers) {
                if (manager?._bms_pipeline === pipeline) manager._bms_pipeline = null;
            }
        }
        for (const manager of backgroundManagers) {
            if (manager) {
                if (!blurActor) manager.backgroundActor = null;
                manager.destroy();
            }
        }
        if (blurActor) {
            if (nativeEffect) blurActor.remove_effect(nativeEffect);
            blurActor.destroy();
        }
        this._staticGroup?.destroy();
        this._staticGroup = null;
        this._staticOwner = null;
        this._staticMonitorIndex = -1;
    }

    _disconnectStaticGeometry() {
        for (const [actor, id] of this._staticOwnerSignals) {
            try {
                actor.disconnect(id);
            } catch (error) {}
        }
        this._staticOwnerSignals = [];
    }

    _useStaticFallback() {
        this._active = true;
        this.actor.add_style_class_name('static-blur-fallback');
    }

    _connectBmsSettings(bms) {
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

    remove() {
        this._staticGeneration++;
        this._staticPending = false;
        this._active = false;
        this._disconnectSettings();

        if (this._mappedSignalId) {
            this.actor.disconnect(this._mappedSignalId);
            this._mappedSignalId = 0;
        }
        if (this._staticRefreshId) {
            global.compositor.get_laters().remove(this._staticRefreshId);
            this._staticRefreshId = 0;
        }
        this._destroyStaticLayer();

        if (this._scaleSignalId) {
            this._themeContext.disconnect(this._scaleSignalId);
            this._scaleSignalId = 0;
        }

        if (this.effect) {
            const bms = global.blur_my_shell;
            if (this._isBmsEffect && bms?._effects_manager) {
                try {
                    bms._effects_manager.remove(this.effect);
                } catch (error) {
                    this.actor.remove_effect(this.effect);
                }
            } else {
                this.actor.remove_effect(this.effect);
            }
            this.effect = null;
            this._isBmsEffect = false;
        }
        this.actor.remove_style_class_name('static-blur-fallback');
    }

    _disconnectSettings() {
        const bms = global.blur_my_shell;
        if (bms?._settings?.settings && this._settingsSignals.length > 0) {
            for (const id of this._settingsSignals) {
                try {
                    bms._settings.settings.disconnect(id);
                } catch (error) {}
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
