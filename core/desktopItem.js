import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { BaseWidget } from './baseWidget.js';
import { trashFileAsync } from './asyncUtils.js';

let activeContextMenuOwner = null;

export function dismissActiveContextMenuAt(x, y, button = 0) {
    const owner = activeContextMenuOwner;
    const menuActor = owner?._menu?.actor;
    if (!menuActor?.visible) return 'none';

    const [menuX, menuY] = menuActor.get_transformed_position();
    const [menuWidth, menuHeight] = menuActor.get_transformed_size();
    const insideMenu = x >= menuX && x <= menuX + menuWidth &&
        y >= menuY && y <= menuY + menuHeight;
    if (insideMenu) return 'inside';

    owner._destroyMenu();
    if (button === 3) {
        owner.setEditMode(false);
        return 'dismissed-right-click';
    }
    return 'dismissed';
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
        this.onSelectionRequested = params.onSelectionRequested ?? (() => {});
        this.getSelectedItems = params.getSelectedItems ?? (() => [this]);
        this.onSelectAll = params.onSelectAll ?? (() => {});
        this.onTrashItems = params.onTrashItems ?? (items => {
            for (const item of items) {
                trashFileAsync(item.file).catch(error => {
                    console.error(`[Widgets] Could not move to trash: ${error.message}`);
                });
            }
        });
        this.isSelected = false;
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
        this.connect('button-press-event', (actor, event) => {
            if (this._isDraggingWidget || this._pointerGrab) return Clutter.EVENT_STOP;

            const button = event.get_button();
            if (button === 3) {
                this.onSelectionRequested(this, event.get_state(), true);
                this.setEditMode(true);
                this._showContextMenu(event.get_coords());
                return Clutter.EVENT_STOP;
            }

            if (button === 1) this.onSelectionRequested(this, event.get_state());

            if (button === 1 && this.isEditMode) {
                this._beginPointerDrag(event);
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
            if (this._updatePointerDrag(event)) this._destroyMenu();
            return Clutter.EVENT_STOP;
        });

        this.connect('button-release-event', (_actor, event) => {
            const didMove = this._finishPointerDrag(event);
            if (didMove === null) return Clutter.EVENT_PROPAGATE;

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

    setSelected(selected) {
        this.isSelected = selected;
        if (selected) {
            this.add_style_class_name('desktop-item-selected');
        } else {
            this.remove_style_class_name('desktop-item-selected');
        }
    }

    _showContextMenu([x, y]) {
        if (activeContextMenuOwner === this && this._menu) {
            this._destroyMenu();
            this.setEditMode(false);
            return;
        }
        if (activeContextMenuOwner && activeContextMenuOwner !== this) {
            activeContextMenuOwner._destroyMenu();
        }
        this._destroyMenu();
        this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP, 0);
        activeContextMenuOwner = this;
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.set_position(x, y);
        this._menu.actor.hide();

        const selectedItems = this.getSelectedItems();
        const files = selectedItems.length > 1 ? selectedItems : [this];
        this._menu.addAction(_('Open'), () => {
            for (const item of files) item._open();
        });
        this._menu.addAction(_('Show in Files'), () => this._showInFiles(files));
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction(
            files.length > 1
                ? _('Move %d items to Trash').replace('%d', String(files.length))
                : _('Move to Trash'),
            () => this.onTrashItems(files)
        );
        this._menu.addAction(_('Select All'), () => this.onSelectAll());
        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
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

    _showInFiles(items = [this]) {
        try {
            const uris = items.map(item => item.file.get_uri());
            Gio.DBus.session.call(
                'org.freedesktop.FileManager1',
                '/org/freedesktop/FileManager1',
                'org.freedesktop.FileManager1',
                'ShowItems',
                new GLib.Variant('(ass)', [uris, '']),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (_conn, result) => {
                    try {
                        Gio.DBus.session.call_finish(result);
                    } catch {
                        const parent = items[0]?.file.get_parent();
                        if (parent) Gio.AppInfo.launch_default_for_uri(parent.get_uri(), null);
                    }
                }
            );
        } catch {
            const parent = items[0]?.file.get_parent();
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
