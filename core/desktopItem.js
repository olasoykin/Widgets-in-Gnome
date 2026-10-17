import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { BaseWidget } from './baseWidget.js';

let activeContextMenuOwner = null;

export function dismissActiveContextMenuAt(x, y) {
    const menuActor = activeContextMenuOwner?._menu?.actor;
    if (!menuActor?.visible) return;

    const [menuX, menuY] = menuActor.get_transformed_position();
    const [menuWidth, menuHeight] = menuActor.get_transformed_size();
    if (x < menuX || x > menuX + menuWidth || y < menuY || y > menuY + menuHeight) {
        activeContextMenuOwner._destroyMenu();
    }
}

export const DesktopItem = GObject.registerClass(
{ GTypeName: 'WidgetsDesktopItem' },
class DesktopItem extends BaseWidget {
    _init(params = {}) {
        super._init({
            ...params,
            colSpan: 1,
            rowSpan: 1,
            minColSpan: 1,
            maxColSpan: 1,
            minRowSpan: 1,
            maxRowSpan: 1,
            resizable: false,
        });

        this.file = params.file;
        this.onPositionChanged = params.onPositionChanged ?? (() => {});
        this._menu = null;
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'desktop-item-content',
        });
        this._icon = new St.Icon({
            ...(params.icon
                ? { gicon: params.icon }
                : { icon_name: 'text-x-generic-symbolic' }),
            icon_size: 48,
            style_class: 'desktop-item-icon',
        });
        this._label = new St.Label({
            text: params.name,
            style_class: 'desktop-item-label',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(this._icon);
        content.add_child(this._label);
        this.setCard(content);
        this.setBlurEnabled(false);

        this.connect('destroy', () => this._destroyMenu());
    }

    _setupDragAndEvents() {
        let grabOffsetX = 0;
        let grabOffsetY = 0;
        let hasMoved = false;

        this.connect('button-press-event', (actor, event) => {
            const button = event.get_button();
            if (button === 3) {
                this.setEditMode(true);
                this._showContextMenu(event.get_coords());
                return Clutter.EVENT_STOP;
            }

            if (button === 1 && this.isEditMode) {
                const [stageX, stageY] = event.get_coords();
                grabOffsetX = stageX - this.x;
                grabOffsetY = stageY - this.y;
                hasMoved = false;
                this._isDraggingWidget = true;
                this._card?.add_style_class_name('no-drag-shadow');
                this.set_scale(1.04, 1.04);
                this.set_opacity(230);
                return Clutter.EVENT_STOP;
            }

            if (button === 1 && event.get_click_count() === 2) {
                this._open();
                return Clutter.EVENT_STOP;
            }

            return button === 1 ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        });

        this.connect('motion-event', (actor, event) => {
            if (!this._isDraggingWidget) return Clutter.EVENT_PROPAGATE;
            const [stageX, stageY] = event.get_coords();
            this.set_position(stageX - grabOffsetX, stageY - grabOffsetY);
            hasMoved = true;
            this._destroyMenu();
            return Clutter.EVENT_STOP;
        });

        this.connect('button-release-event', () => {
            if (!this._isDraggingWidget) return Clutter.EVENT_PROPAGATE;
            this._isDraggingWidget = false;

            if (hasMoved) {
                const colStep = this.grid.cellWidth + this.grid.gapX;
                const rowStep = this.grid.cellHeight + this.grid.gapY;
                const targetCol = Math.round((this.x - this.grid.startX) / colStep);
                const targetRow = Math.round((this.y - this.grid.startY) / rowStep);
                const position = this._findAvailablePosition(
                    Math.max(0, Math.min(this.grid.columns - 1, targetCol)),
                    Math.max(0, Math.min(this.grid.rows - 1, targetRow))
                );
                if (position) {
                    this.col = position.col;
                    this.row = position.row;
                }
            }

            this.animateToGrid(220);
            this._card?.remove_style_class_name('no-drag-shadow');
            this.onPositionChanged();
            return Clutter.EVENT_STOP;
        });
    }

    _showEditOverlay() {
        super._showEditOverlay();
        this._selectionBorder?.add_style_class_name('desktop-item-selection-border');
    }

    _showContextMenu([x, y]) {
        if (activeContextMenuOwner && activeContextMenuOwner !== this) {
            activeContextMenuOwner._destroyMenu();
        }
        this._destroyMenu();
        this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP, 0);
        activeContextMenuOwner = this;
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.set_position(x, y);
        this._menu.actor.hide();

        this._menu.addAction(_('Remove from desktop (move to trash)'), () => {
            try {
                this.file.trash(null);
            } catch (error) {
                console.error(`[Widgets] Could not move to trash: ${error.message}`);
            }
        });
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction(_('Open'), () => this._open());
        this._menu.addAction(_('Show in Files'), () => this._showInFiles());
        this._menu.addAction(_('Move'), () => this.setEditMode(true));
        this._menu.open();
    }

    _open() {
        try {
            const path = this.file.get_path();
            if (path?.endsWith('.desktop')) {
                const desktopApp = Gio.DesktopAppInfo.new_from_filename(path);
                if (desktopApp?.launch([], null)) return;
            }
            Gio.AppInfo.launch_default_for_uri(this.file.get_uri(), null);
        } catch (error) {
            console.error(`[Widgets] Could not open ${this.file.get_uri()}: ${error.message}`);
        }
    }

    _showInFiles() {
        try {
            Gio.Subprocess.new(
                ['nautilus', '--select', this.file.get_uri()],
                Gio.SubprocessFlags.NONE
            );
        } catch (error) {
            const parent = this.file.get_parent();
            if (parent) Gio.AppInfo.launch_default_for_uri(parent.get_uri(), null);
        }
    }

    _destroyMenu() {
        if (!this._menu) return;
        this._menu.destroy();
        this._menu = null;
        if (activeContextMenuOwner === this) activeContextMenuOwner = null;
    }
});