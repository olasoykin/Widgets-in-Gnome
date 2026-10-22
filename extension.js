import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Grid } from './core/grid.js';
import { DesktopItem, dismissActiveContextMenuAt } from './core/desktopItem.js';
import { GridOverlay } from './ui/gridOverlay.js';
import { registerFonts, unregisterFonts } from './core/fontLoader.js';

export default class WidgetsExtension extends Extension {
    enable() {
        registerFonts(this.path);
        this._settings = this.getSettings();
        this._settingsSignals = [];
        this._widgets = [];
        this._pluginWidgets = [];
        this._desktopItems = [];
        this._widgetCatalog = [];
        this._desktopMenu = null;
        this._desktopMenuAnchor = null;
        this._widgetManagerDialog = null;
        this._widgetManagerScroll = null;
        this._widgetManagerPreviewWidgets = [];
        this._widgetManagerPreviewJobs = [];
        this._widgetManagerPreviewSourceId = 0;
        this._widgetsLoaded = false;
        this._widgetLoadGeneration = 0;
        this._desktopPositions = this._loadDesktopPositions();
        this._widgetPositions = this._loadWidgetPositions();

        const monitor = Main.layoutManager.primaryMonitor;
        const topOffset = Main.panel ? Main.panel.height : 36;

        this._grid = new Grid({
            rows: this._settings.get_int('rows'),
            gap: this._settings.get_int('gap'),
            margin: 16,
            topOffset,
            monitor: {
                x: monitor ? monitor.x : 0,
                y: monitor ? monitor.y : 0,
                width: monitor ? monitor.width : 1920,
                height: monitor ? monitor.height : 1080,
            },
        });

        this._container = new Clutter.Actor({
            layout_manager: new Clutter.FixedLayout(),
            // This actor receives clicks only on the empty desktop. Reactive child
            // widgets and desktop items remain the event targets above it.
            reactive: true,
        });
        const [stageWidth, stageHeight] = global.stage.get_size();
        this._container.set_size(stageWidth, stageHeight);
        this._container.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== 3) return Clutter.EVENT_PROPAGATE;

            const [x, y] = event.get_coords();
            this._showDesktopMenu(x, y);
            return Clutter.EVENT_STOP;
        });

        this._overlay = new GridOverlay(this._grid);
        this._overlay.visible = this._settings.get_boolean('show-grid-overlay');
        this._container.add_child(this._overlay);

        if (Main.layoutManager._backgroundGroup) {
            Main.layoutManager._backgroundGroup.add_child(this._container);
        } else {
            Main.layoutManager.uiGroup.insert_child_at_index(this._container, 0);
        }

        this._bindSettings();
        this._bindMonitors();
        this._stageEventId = global.stage.connect('captured-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS) return Clutter.EVENT_PROPAGATE;

            const button = event.get_button();
            const [x, y] = event.get_coords();
            const openMenuActor = this._desktopMenu?.actor;
            if (openMenuActor?.visible) {
                const [menuX, menuY] = openMenuActor.get_transformed_position();
                const [menuWidth, menuHeight] = openMenuActor.get_transformed_size();
                const insideMenu = x >= menuX && x <= menuX + menuWidth &&
                    y >= menuY && y <= menuY + menuHeight;
                if (insideMenu) return Clutter.EVENT_PROPAGATE;

                this._destroyDesktopMenu();
                if (button === 3) return Clutter.EVENT_STOP;
            }

            const itemMenuState = dismissActiveContextMenuAt(x, y, button);
            if (itemMenuState === 'inside') return Clutter.EVENT_PROPAGATE;

            if (button !== 1 && button !== 3) return Clutter.EVENT_PROPAGATE;

            for (const widget of this._widgets) {
                if (!widget.isEditMode) continue;
                const [widgetX, widgetY] = widget.get_transformed_position();
                const [widgetWidth, widgetHeight] = widget.get_transformed_size();
                const handlePadding = widget.resizable ? 10 : 0;
                const inside = x >= widgetX - handlePadding &&
                    x <= widgetX + widgetWidth + handlePadding &&
                    y >= widgetY - handlePadding &&
                    y <= widgetY + widgetHeight + handlePadding;
                if (!inside) widget.setEditMode(false);
            }

            if (itemMenuState === 'dismissed-right-click') return Clutter.EVENT_STOP;

            return Clutter.EVENT_PROPAGATE;
        });
        this._loadDesktopItems();
        this._watchDesktopDirectory();
        this._loadWidgets();
    }

    _getDesktopDirectory() {
        const path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP) ??
            GLib.build_filenamev([GLib.get_home_dir(), 'Desktop']);
        return Gio.File.new_for_path(path);
    }

    _showDesktopMenu(x, y) {
        this._destroyDesktopMenu();

        // PopupMenu positions itself relative to its source actor when opened.
        // Use a 1px invisible actor at the pointer instead of the full-screen
        // desktop container, otherwise the requested click position is ignored.
        const anchor = new Clutter.Actor({ reactive: false, width: 1, height: 1 });
        anchor.set_opacity(0);
        Main.uiGroup.add_child(anchor);
        anchor.set_position(x, y);
        this._desktopMenuAnchor = anchor;

        const menu = new PopupMenu.PopupMenu(anchor, 0.5, St.Side.TOP, 0);
        this._desktopMenu = menu;
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();

        menu.addAction(_('Change Background…'), () => this._launchControlCenter('background'));
        menu.addAction(_('Display Settings'), () => this._launchControlCenter('display'));
        menu.addAction(_('New Folder'), () => this._createDesktopFolder());
        menu.addAction(_('Open Desktop Folder'), () => {
            Gio.AppInfo.launch_default_for_uri(this._getDesktopDirectory().get_uri(), null);
        });
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Manage Widgets…'), () => this._openWidgetManager());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(_('Desktop Settings'), () => this.openPreferences());

        menu.connect('menu-closed', () => {
            if (this._desktopMenu === menu) {
                this._destroyDesktopMenu();
            }
        });
        menu.open();
    }

    _createDesktopFolder() {
        const directory = this._getDesktopDirectory();
        for (let index = 1; index < 1000; index++) {
            const name = index === 1 ? _('New Folder') : _('New Folder (%d)').replace('%d', String(index));
            const folder = directory.get_child(name);
            if (folder.query_exists(null)) continue;
            try {
                folder.make_directory(null);
            } catch (error) {
                console.error(`[Widgets] Could not create desktop folder: ${error.message}`);
            }
            return;
        }
    }

    _launchControlCenter(panel) {
        try {
            Gio.Subprocess.new(['gnome-control-center', panel], Gio.SubprocessFlags.NONE);
        } catch (error) {
            console.error(`[Widgets] Could not open ${panel} settings: ${error.message}`);
        }
    }

    _openWidgetManager() {
        if (this._widgetManagerDialog) return;

        const dialog = new ModalDialog.ModalDialog({
            styleClass: 'desktop-widget-manager-dialog',
        });
        this._widgetManagerDialog = dialog;

        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'desktop-widget-manager-content',
            x_expand: true,
        });
        const heading = new St.Label({
            text: _('Desktop widgets'),
            style_class: 'desktop-widget-manager-heading',
            x_align: Clutter.ActorAlign.START,
        });
        const description = new St.Label({
            text: _('Preview your widgets and choose which ones appear on the desktop.'),
            style_class: 'desktop-widget-manager-description',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        });
        const headingBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'desktop-widget-manager-header',
            x_expand: true,
        });
        headingBox.add_child(heading);
        headingBox.add_child(description);
        content.add_child(headingBox);

        this._widgetManagerScroll = new St.ScrollView({
            style_class: 'desktop-widget-manager-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._widgetManagerScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        content.add_child(this._widgetManagerScroll);
        dialog.contentLayout.add_child(content);
        dialog.setButtons([{
            label: _('Close'),
            action: () => dialog.close(),
            key: Clutter.KEY_Escape,
            default: true,
            cancel: true,
        }]);
        dialog.connect('closed', () => {
            if (this._widgetManagerDialog !== dialog) return;
            this._widgetManagerDialog = null;
            this._widgetManagerScroll = null;
            this._destroyWidgetManagerPreviews();
            dialog.destroy();
        });

        dialog.open();
        this._renderWidgetManager();
    }

    _closeWidgetManager() {
        const dialog = this._widgetManagerDialog;
        this._widgetManagerDialog = null;
        this._widgetManagerScroll = null;
        this._destroyWidgetManagerPreviews();
        if (dialog) {
            dialog.close();
            dialog.destroy();
        }
    }

    _renderWidgetManager() {
        if (!this._widgetManagerScroll) return;
        this._destroyWidgetManagerPreviews();

        if (this._widgetCatalog.length === 0) {
            const message = new St.Label({
                text: this._widgetsLoaded ? _('No widgets are available.') : _('Loading widgets…'),
                style_class: 'desktop-widget-manager-empty',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
            });
            this._widgetManagerScroll.set_child(message);
            return;
        }

        const grid = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'desktop-widget-manager-grid',
            x_expand: true,
        });
        for (let index = 0; index < this._widgetCatalog.length; index += 2) {
            const row = new St.BoxLayout({
                style_class: 'desktop-widget-manager-row',
                x_expand: true,
            });
            for (const entry of this._widgetCatalog.slice(index, index + 2)) {
                row.add_child(this._createWidgetManagerCard(entry));
            }
            if (this._widgetCatalog.length % 2 !== 0 && index + 2 >= this._widgetCatalog.length) {
                row.add_child(new St.Widget({ style_class: 'desktop-widget-manager-spacer', x_expand: true }));
            }
            grid.add_child(row);
        }
        this._widgetManagerScroll.set_child(grid);
        this._scheduleWidgetManagerPreviewBuild();
    }

    _createWidgetManagerCard(entry) {
        const card = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'desktop-widget-manager-card',
            x_expand: true,
        });
        const previewWidth = 300;
        const previewHeight = 190;
        const preview = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            style_class: 'desktop-widget-manager-preview',
            width: previewWidth,
            height: previewHeight,
            reactive: false,
        });
        preview.set_clip(0, 0, previewWidth, previewHeight);
        const placeholder = new St.Label({
            text: _('Loading preview…'),
            style_class: 'desktop-widget-manager-preview-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        preview.add_child(placeholder);
        this._widgetManagerPreviewJobs.push({ entry, preview, placeholder });
        card.add_child(preview);

        const footer = new St.BoxLayout({
            style_class: 'desktop-widget-manager-footer',
            x_expand: true,
        });
        const title = new St.Label({
            text: entry.name,
            style_class: 'desktop-widget-manager-title',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
        });
        footer.add_child(title);

        let enabled = !new Set(this._settings.get_strv('disabled-widgets')).has(entry.filename);
        const toggle = new St.Button({
            style_class: 'desktop-widget-manager-switch-button',
            can_focus: true,
            reactive: true,
        });
        const track = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            style_class: `desktop-widget-manager-switch-track${enabled ? ' desktop-widget-manager-switch-active' : ''}`,
            width: 44,
            height: 26,
            reactive: false,
        });
        const thumb = new St.Widget({
            style_class: 'desktop-widget-manager-switch-thumb',
            x: enabled ? 20 : 2,
            y: 2,
            width: 22,
            height: 22,
            reactive: false,
        });
        track.add_child(thumb);
        toggle.set_child(track);
        toggle.connect('clicked', () => {
            enabled = !enabled;
            if (enabled) track.add_style_class_name('desktop-widget-manager-switch-active');
            else track.remove_style_class_name('desktop-widget-manager-switch-active');
            thumb.set_position(enabled ? 20 : 2, 2);

            const updated = new Set(this._settings.get_strv('disabled-widgets'));
            if (enabled) updated.delete(entry.filename);
            else updated.add(entry.filename);
            this._settings.set_strv('disabled-widgets', [...updated].sort());
        });
        footer.add_child(toggle);

        card.add_child(footer);
        return card;
    }

    _scheduleWidgetManagerPreviewBuild() {
        if (this._widgetManagerPreviewSourceId || this._widgetManagerPreviewJobs.length === 0) return;

        this._widgetManagerPreviewSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 16, () => {
            if (!this._widgetManagerDialog || !this._widgetManagerScroll) {
                this._widgetManagerPreviewSourceId = 0;
                this._widgetManagerPreviewJobs = [];
                return GLib.SOURCE_REMOVE;
            }

            const job = this._widgetManagerPreviewJobs.shift();
            if (job?.preview.get_parent()) {
                this._createWidgetManagerPreview(job.entry, job.preview, job.placeholder);
            }

            if (this._widgetManagerPreviewJobs.length > 0) return GLib.SOURCE_CONTINUE;
            this._widgetManagerPreviewSourceId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _createWidgetManagerPreview(entry, preview, placeholder) {
        placeholder.destroy();

        try {
            const config = entry.config;
            const colSpan = config.colSpan ?? 2;
            const rowSpan = config.rowSpan ?? 2;
            const previewCellSize = 100;
            const grid = {
                columns: colSpan,
                rows: rowSpan,
                startX: 0,
                startY: 0,
                gapX: 0,
                gapY: 0,
                cellWidth: previewCellSize,
                cellHeight: previewCellSize,
                isValidCell: (col, row, width, height) =>
                    col >= 0 && row >= 0 && col + width <= colSpan && row + height <= rowSpan,
                getCellRect: (col, row, width, height) => ({
                    x: col * previewCellSize,
                    y: row * previewCellSize,
                    width: width * previewCellSize,
                    height: height * previewCellSize,
                }),
            };
            const previewWidget = new entry.Widget({
                ...config,
                grid,
                col: 0,
                row: 0,
                colSpan,
                rowSpan,
                resizable: false,
            });
            this._widgetManagerPreviewWidgets.push(previewWidget);
            const previewScale = Math.min(
                preview.width / (colSpan * previewCellSize),
                preview.height / (rowSpan * previewCellSize)
            );
            const previewX = (preview.width - colSpan * previewCellSize * previewScale) / 2;
            const previewY = (preview.height - rowSpan * previewCellSize * previewScale) / 2;
            previewWidget.connect('notify::mapped', () => {
                if (!previewWidget.mapped) return;
                previewWidget.set_pivot_point(0, 0);
                previewWidget.set_scale(previewScale, previewScale);
                previewWidget.set_position(previewX, previewY);
            });
            previewWidget.setBlurEnabled(false);
            this._setPreviewReactive(previewWidget, false);
            preview.add_child(previewWidget);
        } catch (error) {
            console.warn(`[Widgets] Could not preview ${entry.filename}: ${error.message}`);
            preview.add_child(new St.Label({
                text: _('Preview unavailable'),
                style_class: 'desktop-widget-manager-preview-empty',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
            }));
        }
    }

    _setPreviewReactive(actor, reactive) {
        actor.reactive = reactive;
        for (const child of actor.get_children()) {
            this._setPreviewReactive(child, reactive);
        }
    }

    _destroyWidgetManagerPreviews() {
        if (this._widgetManagerPreviewSourceId) {
            GLib.source_remove(this._widgetManagerPreviewSourceId);
            this._widgetManagerPreviewSourceId = 0;
        }
        this._widgetManagerPreviewJobs = [];
        for (const widget of this._widgetManagerPreviewWidgets) {
            try {
                widget.destroy();
            } catch (e) {
                console.error(`[Widgets] Error destroying preview widget: ${e.message}`);
            }
        }
        this._widgetManagerPreviewWidgets = [];
    }

    _destroyDesktopMenu() {
        if (!this._desktopMenu && !this._desktopMenuAnchor) return;
        const menu = this._desktopMenu;
        const anchor = this._desktopMenuAnchor;
        this._desktopMenu = null;
        this._desktopMenuAnchor = null;
        menu?.destroy();
        anchor?.destroy();
    }

    _getDesktopPositionsPath() {
        return GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'widgets@kin',
            'desktop-items.json',
        ]);
    }

    _loadDesktopPositions() {
        try {
            const [ok, contents] = GLib.file_get_contents(this._getDesktopPositionsPath());
            return ok ? JSON.parse(new TextDecoder().decode(contents)) : {};
        } catch (_error) {
            return {};
        }
    }

    _saveDesktopPositions() {
        try {
            const path = this._getDesktopPositionsPath();
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
            const positions = {};
            for (const item of this._desktopItems) {
                positions[item.file.get_uri()] = { col: item.col, row: item.row };
            }
            GLib.file_set_contents(path, JSON.stringify(positions));
            this._desktopPositions = positions;
        } catch (error) {
            console.error(`[Widgets] No se pudieron guardar posiciones: ${error.message}`);
        }
    }

    _getWidgetPositionsPath() {
        return GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'widgets@kin',
            'widget-positions.json',
        ]);
    }

    _loadWidgetPositions() {
        try {
            const [ok, contents] = GLib.file_get_contents(this._getWidgetPositionsPath());
            return ok ? JSON.parse(new TextDecoder().decode(contents)) : {};
        } catch (_error) {
            return {};
        }
    }

    _saveWidgetPositions() {
        if (!this._widgetsLoaded) return;
        try {
            const path = this._getWidgetPositionsPath();
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
            const positions = { ...(this._widgetPositions ?? {}) };
            for (const widget of this._pluginWidgets) {
                if (widget.widgetId) {
                    positions[widget.widgetId] = {
                        col: widget.col,
                        row: widget.row,
                        colSpan: widget.colSpan,
                        rowSpan: widget.rowSpan,
                    };
                }
            }
            GLib.file_set_contents(path, JSON.stringify(positions));
            this._widgetPositions = positions;
        } catch (error) {
            console.error(`[Widgets] No se pudieron guardar posiciones de widgets: ${error.message}`);
        }
    }

    _loadDesktopItems() {
        const directory = this._getDesktopDirectory();
        let enumerator;
        try {
            enumerator = directory.enumerate_children(
                'standard::name,standard::display-name,standard::type,standard::icon',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
        } catch (error) {
            console.warn(`[Widgets] No se pudo leer la carpeta Escritorio: ${error.message}`);
            return;
        }

        const found = new Map();
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const file = directory.get_child(info.get_name());
            found.set(file.get_uri(), { file, info });
        }
        enumerator.close(null);

        const existing = new Map(this._desktopItems.map(item => [item.file.get_uri(), item]));
        for (const [uri, item] of existing) {
            if (!found.has(uri)) {
                this._desktopItems = this._desktopItems.filter(candidate => candidate !== item);
                this._widgets = this._widgets.filter(candidate => candidate !== item);
                item.destroy();
            }
        }

        for (const [uri, entry] of found) {
            if (existing.has(uri)) continue;
            const preferred = this._desktopPositions[uri];
            const position = this._findWidgetPosition(1, 1, preferred?.col, preferred?.row);
            if (!position) {
                console.warn(`[Widgets] No hay una celda libre para ${entry.info.get_name()}`);
                continue;
            }

            let icon = entry.info.get_icon();
            if (entry.file.get_path()?.endsWith('.desktop')) {
                try {
                    icon = Gio.DesktopAppInfo.new_from_filename(entry.file.get_path())?.get_icon() ?? icon;
                } catch {}
            }

            const item = new DesktopItem({
                grid: this._grid,
                ...position,
                file: entry.file,
                name: entry.info.get_display_name(),
                icon,
                onPositionChanged: () => this._saveDesktopPositions(),
            });
            item.widgetId = `desktop:${uri}`;
            this._desktopItems.push(item);
            this._widgets.push(item);
            this._container.add_child(item);
            item.updateGeometry();
            item.animateIntoGrid(380);
        }

        this._saveDesktopPositions();
    }

    _watchDesktopDirectory() {
        try {
            this._desktopMonitor = this._getDesktopDirectory().monitor_directory(
                Gio.FileMonitorFlags.WATCH_MOVES,
                null
            );
            this._desktopMonitorId = this._desktopMonitor.connect('changed', () => {
                if (this._desktopRefreshId) GLib.source_remove(this._desktopRefreshId);
                this._desktopRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    this._desktopRefreshId = 0;
                    this._loadDesktopItems();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (error) {
            console.warn(`[Widgets] No se pudo vigilar la carpeta Escritorio: ${error.message}`);
        }
    }

    async _loadWidgets() {
        const generation = ++this._widgetLoadGeneration;
        const widgetsDirectory = this.dir.get_child('widgets');
        const enumerator = widgetsDirectory.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        const filenames = [];
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() === Gio.FileType.REGULAR && info.get_name().endsWith('.js')) {
                filenames.push(info.get_name());
            }
        }
        enumerator.close(null);
        filenames.sort();
        const disabledWidgets = new Set(this._settings.get_strv('disabled-widgets'));
        this._widgetCatalog = [];

        for (const filename of filenames) {
            if (!this._container || generation !== this._widgetLoadGeneration) return;

            try {
                const uri = widgetsDirectory.get_child(filename).get_uri();
                const module = await import(uri);
                if (!this._container || generation !== this._widgetLoadGeneration) return;
                if (typeof module.Widget !== 'function') {
                    console.warn(`[Widgets] ${filename} no exporta una clase Widget`);
                    continue;
                }

                const entry = {
                    filename,
                    name: module.WIDGET_NAME ?? filename.replace(/\.js$/, ''),
                    Widget: module.Widget,
                    config: module.WIDGET_CONFIG ?? {},
                };
                this._widgetCatalog.push(entry);
                if (disabledWidgets.has(filename)) continue;
                this._addWidgetFromCatalog(entry);
            } catch (error) {
                console.error(`[Widgets] No se pudo cargar ${filename}: ${error.message}\n${error.stack ?? ''}`);
            }
        }
        this._widgetsLoaded = true;
        this._saveWidgetPositions();
        this._renderWidgetManager();
    }

    _addWidgetFromCatalog(entry) {
        if (this._pluginWidgets.some(widget => widget.widgetId === entry.filename)) return;

        const config = entry.config;
        const saved = this._widgetPositions[entry.filename];
        const colSpan = saved?.colSpan ?? config.colSpan ?? 2;
        const rowSpan = saved?.rowSpan ?? config.rowSpan ?? 2;
        const position = this._findWidgetPosition(
            colSpan,
            rowSpan,
            saved?.col ?? config.col,
            saved?.row ?? config.row
        );
        if (!position) {
            console.warn(`[Widgets] No hay espacio disponible para ${entry.filename}`);
            return;
        }

        try {
            const widget = new entry.Widget({
                ...config,
                grid: this._grid,
                col: position.col,
                row: position.row,
                colSpan,
                rowSpan,
            });
            widget.widgetId = entry.filename;
            widget.connect('geometry-changed', () => this._saveWidgetPositions());
            this._widgets.push(widget);
            this._pluginWidgets.push(widget);
            this._container.add_child(widget);
            widget.animateIntoGrid();
            widget.setBlurEnabled(this._settings.get_boolean('enable-blur'));
            widget.setStaticBlurEnabled(this._settings.get_boolean('static-blur'));
        } catch (error) {
            console.error(`[Widgets] No se pudo cargar ${entry.filename}: ${error.message}\n${error.stack ?? ''}`);
        }
    }

    _syncWidgetsWithSettings() {
        const disabled = new Set(this._settings.get_strv('disabled-widgets'));
        const removed = this._pluginWidgets.filter(widget => disabled.has(widget.widgetId));
        for (const widget of removed) {
            try {
                widget.destroy();
            } catch (e) {
                console.error(`[Widgets] Error destroying widget: ${e.message}`);
            }
        }
        if (removed.length > 0) {
            const removedSet = new Set(removed);
            this._pluginWidgets = this._pluginWidgets.filter(widget => !removedSet.has(widget));
            this._widgets = this._widgets.filter(widget => !removedSet.has(widget));
        }

        for (const entry of this._widgetCatalog) {
            if (!disabled.has(entry.filename)) this._addWidgetFromCatalog(entry);
        }
        this._saveWidgetPositions();
    }

    _reloadWidgets() {
        this._widgetsLoaded = false;
        this._widgetLoadGeneration++;
        for (const widget of this._pluginWidgets) {
            try {
                widget.destroy();
            } catch (e) {
                console.error(`[Widgets] Error destroying widget: ${e.message}`);
            }
            this._widgets = this._widgets.filter(candidate => candidate !== widget);
        }
        this._pluginWidgets = [];
        this._loadWidgets();
    }

    _findWidgetPosition(colSpan, rowSpan, preferredCol, preferredRow) {
        const isAvailable = (col, row) => {
            if (!this._grid.isValidCell(col, row, colSpan, rowSpan)) return false;
            return !this._widgets.some(widget =>
                col < widget.col + widget.colSpan &&
                col + colSpan > widget.col &&
                row < widget.row + widget.rowSpan &&
                row + rowSpan > widget.row
            );
        };

        if (preferredCol !== undefined && preferredRow !== undefined &&
            isAvailable(preferredCol, preferredRow)) {
            return { col: preferredCol, row: preferredRow };
        }

        for (let row = 0; row <= this._grid.rows - rowSpan; row++) {
            for (let col = 0; col <= this._grid.columns - colSpan; col++) {
                if (isAvailable(col, row)) return { col, row };
            }
        }

        return null;
    }

    _bindSettings() {
        const updateGrid = () => {
            if (!this._grid) return;

            const topOffset = Main.panel ? Main.panel.height : 36;
            this._grid.updateConfig({
                rows: this._settings.get_int('rows'),
                gap: this._settings.get_int('gap'),
                margin: 16,
                topOffset,
            });

            if (this._overlay) {
                this._overlay.render();
            }

            for (const widget of this._widgets) {
                widget.updateGeometry({ animate: true });
            }
        };

        const keys = ['rows', 'columns', 'gap', 'symmetric-grid'];
        for (const key of keys) {
            const id = this._settings.connect(`changed::${key}`, updateGrid);
            this._settingsSignals.push(id);
        }

        const overlayId = this._settings.connect('changed::show-grid-overlay', () => {
            if (this._overlay) {
                this._overlay.visible = this._settings.get_boolean('show-grid-overlay');
            }
        });
        this._settingsSignals.push(overlayId);

        const blurId = this._settings.connect('changed::enable-blur', () => {
            for (const widget of this._pluginWidgets) {
                widget.setBlurEnabled(this._settings.get_boolean('enable-blur'));
            }
        });
        this._settingsSignals.push(blurId);

        const staticBlurId = this._settings.connect('changed::static-blur', () => {
            const globalStaticBlur = this._settings.get_boolean('static-blur');
            for (const widget of this._pluginWidgets) {
                widget.setStaticBlurEnabled(globalStaticBlur);
            }
        });
        this._settingsSignals.push(staticBlurId);

        const widgetsId = this._settings.connect('changed::disabled-widgets', () => {
            if (this._widgetsLoaded) this._syncWidgetsWithSettings();
            else this._reloadWidgets();
        });
        this._settingsSignals.push(widgetsId);

        const globalStaticBlur = this._settings.get_boolean('static-blur');
        for (const widget of this._pluginWidgets) {
            widget.setBlurEnabled(this._settings.get_boolean('enable-blur'));
            widget.setStaticBlurEnabled(globalStaticBlur);
        }
    }

    _bindMonitors() {
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            const monitor = Main.layoutManager.primaryMonitor;
            const topOffset = Main.panel ? Main.panel.height : 36;
            if (monitor && this._grid) {
                this._grid.updateConfig({
                    topOffset,
                    monitor: {
                        x: monitor.x,
                        y: monitor.y,
                        width: monitor.width,
                        height: monitor.height,
                    },
                });

                if (this._overlay) {
                    this._overlay.render();
                }

                for (const widget of this._widgets) {
                    widget.updateGeometry({ animate: true });
                }
            }
        });
    }

    disable() {
        this._widgetLoadGeneration++;
        this._destroyDesktopMenu();
        this._closeWidgetManager();
        if (this._stageEventId) {
            global.stage.disconnect(this._stageEventId);
            this._stageEventId = 0;
        }
        if (this._desktopRefreshId) {
            GLib.source_remove(this._desktopRefreshId);
            this._desktopRefreshId = 0;
        }
        if (this._desktopMonitor) {
            if (this._desktopMonitorId) this._desktopMonitor.disconnect(this._desktopMonitorId);
            this._desktopMonitor.cancel();
            this._desktopMonitor = null;
            this._desktopMonitorId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        if (this._settings) {
            for (const id of this._settingsSignals) {
                this._settings.disconnect(id);
            }
            this._settingsSignals = [];
            this._settings = null;
        }

        if (this._container) {
            this._container.destroy();
            this._container = null;
        }

        this._overlay = null;
        this._widgets = [];
        this._grid = null;
        unregisterFonts();
    }
}
