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

// Clutter.Event.get_click_count() was removed from GNOME Shell, so double
// clicks are detected manually from the time and distance between presses.
const DOUBLE_CLICK_INTERVAL_MS = 400;
const DOUBLE_CLICK_DISTANCE_PX = 32;

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

        this._stackBadge = null;
        this._dragState = null;
        this._lastClickInfo = null;

        this.connect('destroy', () => {
            this._removeStackBadge();
            this._destroyMenu();
        });
    }

    get isDragging() {
        return Boolean(this._isDraggingWidget);
    }

    _setupDragAndEvents() {
        this.connect('button-press-event', (actor, event) => {
            if (this._isDraggingWidget || this._pointerGrab) return Clutter.EVENT_STOP;

            const button = event.get_button();
            if (button === 3) {
                this.onSelectionRequested(this, event.get_state(), true, false);
                this.setEditMode(true);
                this._showContextMenu(event.get_coords());
                return Clutter.EVENT_STOP;
            }

            if (button === 1) {
                const pressTime = event.get_time();
                const [pressX, pressY] = event.get_coords();
                const lastClick = this._lastClickInfo;
                const isDoubleClick = lastClick !== null &&
                    pressTime - lastClick.time < DOUBLE_CLICK_INTERVAL_MS &&
                    Math.hypot(pressX - lastClick.x, pressY - lastClick.y) < DOUBLE_CLICK_DISTANCE_PX;
                this._lastClickInfo = isDoubleClick
                    ? null
                    : { time: pressTime, x: pressX, y: pressY };
                if (isDoubleClick) {
                    this._destroyMenu();
                    this._open();
                    return Clutter.EVENT_STOP;
                }
            }

            if (button === 1) {
                const state = event.get_state();
                const controlPressed = (state & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.SHIFT_MASK)) !== 0;

                let willKeepMultiSelection = false;
                if (controlPressed) {
                    this.onSelectionRequested(this, state, false, false);
                } else if (!this.isSelected) {
                    this.onSelectionRequested(this, state, false, false);
                } else if (this.getSelectedItems().length > 1) {
                    willKeepMultiSelection = true;
                }

                this._beginDesktopDrag(event, willKeepMultiSelection);
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('motion-event', (actor, event) => {
            if (!this._isDraggingWidget) return Clutter.EVENT_PROPAGATE;
            if (this._updateDesktopDrag(event)) this._destroyMenu();
            return Clutter.EVENT_STOP;
        });

        this.connect('button-release-event', (_actor, event) => {
            const didMove = this._finishDesktopDrag(event);
            if (didMove === null) return Clutter.EVENT_PROPAGATE;
            return Clutter.EVENT_STOP;
        });
    }

    _beginDesktopDrag(event, willKeepMultiSelection) {
        if (this._isDraggingWidget) return;
        const [stageX, stageY] = event.get_coords();
        const [localX, localY] = this.get_parent().transform_stage_point(stageX, stageY).slice(1);
        this._beginPointerGrab(this);
        this._dragState = {
            startX: localX,
            startY: localY,
            offsetX: localX - this.x,
            offsetY: localY - this.y,
            moved: false,
            willKeepMultiSelection,
            followers: [],
            followOffsets: [],
        };
        this._isDraggingWidget = true;
    }

    _updateDesktopDrag(event) {
        const drag = this._dragState;
        if (!this._isDraggingWidget || !drag) return false;

        const [stageX, stageY] = event.get_coords();
        const [localX, localY] = this.get_parent().transform_stage_point(stageX, stageY).slice(1);
        if (!drag.moved) {
            const dist = Math.hypot(localX - drag.startX, localY - drag.startY);
            if (dist < 8) return false;

            drag.moved = true;
            // A real drag must not count as the first click of a double click.
            this._lastClickInfo = null;
            this._destroyMenu();

            const selectedItems = this.isSelected ? this.getSelectedItems() : [this];
            const followers = selectedItems.filter(item => item !== this);
            drag.followers = followers;

            const parent = this.get_parent();
            if (parent) {
                for (const follower of followers) {
                    parent.set_child_above_sibling(follower, null);
                }
                parent.set_child_above_sibling(this, null);
            }

            // Collapse followers into a stack on top of the dragged icon with
            // a small staggered offset, but at full opacity and scale so they
            // don't look like faded shadow copies.
            drag.followOffsets = followers.map((_item, idx) => {
                const level = Math.min(idx + 1, 4);
                return { dx: level * 5, dy: level * 5 };
            });

            followers.forEach((follower, idx) => {
                const { dx, dy } = drag.followOffsets[idx];
                follower._card?.add_style_class_name('no-drag-shadow');
                follower._card?.add_style_class_name('desktop-item-dragging');
                follower.set_scale(1.0, 1.0);
                follower.set_opacity(255);
                // Initial position is eased by the motion loop below, which
                // glides each follower into the stack over ~80ms.
            });

            this._card?.add_style_class_name('no-drag-shadow');
            this._card?.add_style_class_name('desktop-item-dragging');
            this.save_easing_state();
            this.set_easing_duration(180);
            this.set_easing_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            this.set_scale(1.06, 1.06);
            this.set_opacity(250);
            this.restore_easing_state();

            if (selectedItems.length > 1) {
                this._showStackBadge(selectedItems.length);
            }
        }

        const currentX = localX - drag.offsetX;
        const currentY = localY - drag.offsetY;
        this.set_position(currentX, currentY);

        // Eased follow: followers glide into/along the stack instead of
        // snapping, giving the pile a soft inertia while dragging.
        drag.followers.forEach((follower, idx) => {
            const { dx, dy } = drag.followOffsets[idx];
            follower.save_easing_state();
            follower.set_easing_duration(80);
            follower.set_easing_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            follower.set_position(currentX + dx, currentY + dy);
            follower.restore_easing_state();
        });

        return true;
    }

    _finishDesktopDrag(event) {
        if (!this._isDraggingWidget || event.get_button() !== 1) return null;

        const drag = this._dragState;
        this._isDraggingWidget = false;
        this._dragState = null;
        this._endPointerGrab();
        this._removeStackBadge();

        if (!drag) return null;

        if (!drag.moved) {
            if (drag.willKeepMultiSelection) {
                this.onSelectionRequested(this, event.get_state(), false, true);
            }
            this._card?.remove_style_class_name('no-drag-shadow');
            this._card?.remove_style_class_name('desktop-item-dragging');
            this.animateToGrid(150);
            return false;
        }

        const movingItems = [this, ...drag.followers];
        this._arrangeAndDropItems(movingItems);
        return true;
    }

    cancelDesktopDrag() {
        if (!this._isDraggingWidget) return;
        const drag = this._dragState;
        this._isDraggingWidget = false;
        this._dragState = null;
        this._endPointerGrab();
        this._removeStackBadge();

        const movingItems = drag ? [this, ...drag.followers] : [this];
        for (const item of movingItems) {
            item._card?.remove_style_class_name('no-drag-shadow');
            item._card?.remove_style_class_name('desktop-item-dragging');
            item.animateToGrid(220);
        }
    }

    _arrangeAndDropItems(movingItems) {
        if (!this.grid) return;

        for (const item of movingItems) {
            item._card?.remove_style_class_name('no-drag-shadow');
            item._card?.remove_style_class_name('desktop-item-dragging');
            if (item.isEditMode) item.setEditMode(false);
        }

        const dropCenterX = this.x + this.width / 2;
        const dropCenterY = this.y + this.height / 2;
        const { col: dropCol, row: dropRow } = this.grid.pointToCell(dropCenterX, dropCenterY);

        const movingSet = new Set(movingItems);
        const parent = this.get_parent();
        const allChildren = parent ? parent.get_children() : [];

        const isCellFree = (c, r) => {
            if (!this.grid.isValidCell(c, r, 1, 1)) return false;
            return !allChildren.some(w => {
                if (movingSet.has(w) || w.grid !== this.grid || !w.visible) return false;
                return (
                    c < w.col + w.colSpan &&
                    c + 1 > w.col &&
                    r < w.row + w.rowSpan &&
                    r + 1 > w.row
                );
            });
        };

        const candidates = [];
        for (let r = 0; r < this.grid.rows; r++) {
            for (let c = 0; c < this.grid.columns; c++) {
                if (isCellFree(c, r)) {
                    const dc = c - dropCol;
                    const dr = r - dropRow;
                    let penalty = 0;
                    if (dc < 0) penalty += 1000 * Math.abs(dc);
                    if (dr < 0) penalty += 500 * Math.abs(dr);
                    const score = penalty + dc * this.grid.rows + dr;
                    candidates.push({ col: c, row: r, score });
                }
            }
        }
        candidates.sort((a, b) => a.score - b.score);

        movingItems.forEach((item, idx) => {
            const targetCell = candidates[idx] ?? { col: dropCol, row: dropRow };
            item.col = targetCell.col;
            item.row = targetCell.row;

            const rect = this.grid.getCellRect(item.col, item.row);

            item.save_easing_state();
            item.set_easing_delay(idx * 35);
            item.set_easing_duration(320);
            item.set_easing_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            item.set_position(rect.x, rect.y);
            item.set_size(rect.width, rect.height);
            item.set_scale(1.0, 1.0);
            item.set_opacity(255);
            item.restore_easing_state();
        });

        this.onPositionChanged();
    }

    _showStackBadge(count) {
        this._removeStackBadge();
        this._stackBadge = new St.Label({
            text: String(count),
            style_class: 'desktop-drag-stack-badge',
            y_align: Clutter.ActorAlign.START,
            x_align: Clutter.ActorAlign.END,
        });
        this.add_child(this._stackBadge);
        this._stackBadge.set_position(Math.max(10, this.width - 28), 4);
        this._stackBadge.set_scale(0.5, 0.5);
        this._stackBadge.set_opacity(0);
        this._stackBadge.save_easing_state();
        this._stackBadge.set_easing_duration(180);
        this._stackBadge.set_easing_mode(Clutter.AnimationMode.EASE_OUT_BACK);
        this._stackBadge.set_scale(1.0, 1.0);
        this._stackBadge.set_opacity(255);
        this._stackBadge.restore_easing_state();
    }

    _removeStackBadge() {
        if (!this._stackBadge) return;
        const badge = this._stackBadge;
        this._stackBadge = null;
        badge.save_easing_state();
        badge.set_easing_duration(140);
        badge.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
        badge.set_opacity(0);
        badge.set_scale(0.5, 0.5);
        badge.restore_easing_state();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            badge.destroy();
            return GLib.SOURCE_REMOVE;
        });
    }

    _showEditOverlay() {
        super._showEditOverlay();
        this._selectionBorder?.add_style_class_name('desktop-item-selection-border');
    }

    setSelected(selected) {
        this.isSelected = selected;
        if (selected) {
            this._card?.add_style_class_name('desktop-item-selected');
        } else {
            this._card?.remove_style_class_name('desktop-item-selected');
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
