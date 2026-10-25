import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { BlurManager } from './blur.js';

const GAUGE_COLORS = {
    'widget-gauge-blue': [10 / 255, 132 / 255, 1],
    'widget-gauge-green': [48 / 255, 209 / 255, 88 / 255],
    'widget-gauge-orange': [1, 159 / 255, 10 / 255],
    'widget-gauge-red': [1, 69 / 255, 58 / 255],
};

const POINTER_DRAG_THRESHOLD = 8;

function drawRoundedRect(context, width, height) {
    const radius = Math.min(width / 2, height / 2);
    context.newPath();
    context.arc(width - radius, radius, radius, -Math.PI / 2, 0);
    context.arc(width - radius, height - radius, radius, 0, Math.PI / 2);
    context.arc(radius, height - radius, radius, Math.PI / 2, Math.PI);
    context.arc(radius, radius, radius, Math.PI, 3 * Math.PI / 2);
    context.closePath();
}

export function configureWidgetCaption(label) {
    const text = label.get_clutter_text();
    text.ellipsize = Pango.EllipsizeMode.NONE;
    text.line_wrap = false;
    label.x_expand = true;
    label.x_align = Clutter.ActorAlign.START;
    return label;
}

export const BaseWidget = GObject.registerClass({
    GTypeName: 'WidgetsBaseWidget',
    Signals: {
        'geometry-changed': {},
    },
}, class BaseWidget extends Clutter.Actor {
    _init(params = {}) {
        super._init({
            reactive: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        this.set_pivot_point(0.5, 0.5);

        this.grid = params.grid;
        this.col = params.col ?? 0;
        this.row = params.row ?? 0;
        this.colSpan = params.colSpan ?? 2;
        this.rowSpan = params.rowSpan ?? 2;

        this.minColSpan = params.minColSpan ?? 1;
        this.maxColSpan = params.maxColSpan ?? 6;
        this.minRowSpan = params.minRowSpan ?? 1;
        this.maxRowSpan = params.maxRowSpan ?? 5;
        this.resizable = params.resizable ?? true;
        this.isPreview = Boolean(params.isPreview);
        this._adaptiveLabels = new Map();
        this._adaptiveLabelBaseSizes = new WeakMap();
        this._referenceColSpan = this.colSpan;
        this._referenceRowSpan = this.rowSpan;
        this._disableAdaptiveText = params.disableAdaptiveText ?? true;

        this.isEditMode = false;
        this._isDraggingWidget = false;
        this._isResizing = false;
        this._moveGesture = null;
        this._pointerGrab = null;
        this._blurEnabled = true;
        this._staticBlurEnabled = false;
        this._hideOverlayTimeoutId = 0;
        this._cardChildAddedId = 0;
        this._cardChildRemovedId = 0;
        this._cardAllocationId = 0;
        this._cardContentClipSignals = new Map();

        this._blurWidget = new St.Widget({
            style_class: 'widget-blur-surface',
            reactive: false,
        });
        this.insert_child_at_index(this._blurWidget, 0);

        this._blurManager = new BlurManager(this._blurWidget, {
            cornerRadius: 28,
        });

        this.connect('destroy', () => {
            if (this._hideOverlayTimeoutId) {
                GLib.source_remove(this._hideOverlayTimeoutId);
                this._hideOverlayTimeoutId = 0;
            }
            this._endPointerGrab();
            this._isDraggingWidget = false;
            this._isResizing = false;
            this._moveGesture = null;
            this._disconnectCardContentClips();
            if (this._blurManager) {
                this._blurManager.destroy();
                this._blurManager = null;
            }
        });

        this._setupDragAndEvents();
    }

    get sizeTier() {
        if (this.colSpan >= 3 && this.rowSpan >= 3) return 'large';
        if (this.colSpan >= 3) return 'medium';
        if (this.rowSpan >= 3) return 'tall';
        return 'small';
    }

    refreshAdaptiveLabels() {
        this._adaptiveLabels.clear();
        if (this._card) {
            this._collectAdaptiveLabels(this._card);
        }
        if (this.width > 0 && this.height > 0) {
            this._updateAdaptiveText(this.width, this.height);
        }
    }

    _setupDragAndEvents() {
        this.connect('button-press-event', (actor, event) => {
            if (this._isDraggingWidget || this._isResizing || this._pointerGrab) {
                return Clutter.EVENT_STOP;
            }

            const button = event.get_button();

            if (button === 3) {
                const siblings = this.get_parent()?.get_children() ?? [];
                for (const widget of siblings) {
                    if (widget !== this && widget.isEditMode && typeof widget.setEditMode === 'function') {
                        widget.setEditMode(false);
                    }
                }
                this.setEditMode(!this.isEditMode);
                return Clutter.EVENT_STOP;
            }

            if (button === 1) {
                if (this.isEditMode) {
                    this._beginPointerDrag(event);
                    this._card?.add_style_class_name('widget-no-shadow');

                    this.save_easing_state();
                    this.set_easing_duration(150);
                    this.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
                    this.set_scale(1.04, 1.04);
                    this.set_opacity(230);
                    this.restore_easing_state();
                }
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('motion-event', (actor, event) => {
            if (!this._isDraggingWidget) return Clutter.EVENT_PROPAGATE;
            this._updatePointerDrag(event);
            return Clutter.EVENT_STOP;
        });

        this.connect('button-release-event', (actor, event) => {
            const didMove = this._finishPointerDrag(event);
            if (didMove === null) return Clutter.EVENT_PROPAGATE;

            this.animateToGrid(120);
            this._card?.remove_style_class_name('widget-no-shadow');
            return Clutter.EVENT_STOP;
        });
    }

    _beginPointerDrag(event) {
        if (this._isDraggingWidget) return false;

        const [stageX, stageY] = event.get_coords();
        this._beginPointerGrab(this);
        this._moveGesture = {
            startX: stageX,
            startY: stageY,
            offsetX: stageX - this.x,
            offsetY: stageY - this.y,
            moved: false,
        };
        this._isDraggingWidget = true;
        return true;
    }

    _updatePointerDrag(event) {
        const gesture = this._moveGesture;
        if (!this._isDraggingWidget || !gesture) return false;

        const [stageX, stageY] = event.get_coords();
        if (!gesture.moved &&
            Math.hypot(stageX - gesture.startX, stageY - gesture.startY) < POINTER_DRAG_THRESHOLD) {
            return false;
        }

        if (!gesture.moved) this._blurManager?.raiseOwnerAndStaticLayer();
        gesture.moved = true;
        this.set_position(stageX - gesture.offsetX, stageY - gesture.offsetY);
        return true;
    }

    _finishPointerDrag(event) {
        if (!this._isDraggingWidget || event.get_button() !== 1) return null;

        const didMove = Boolean(this._moveGesture?.moved);
        this._isDraggingWidget = false;
        this._moveGesture = null;
        this._endPointerGrab();

        if (didMove && this.grid) {
            const colStep = this.grid.cellWidth + this.grid.gapX;
            const rowStep = this.grid.cellHeight + this.grid.gapY;
            const targetCol = Math.round((this.x - this.grid.startX) / colStep);
            const targetRow = Math.round((this.y - this.grid.startY) / rowStep);
            const position = this._findAvailablePosition(
                Math.max(0, Math.min(this.grid.columns - this.colSpan, targetCol)),
                Math.max(0, Math.min(this.grid.rows - this.rowSpan, targetRow))
            );
            if (position) {
                this.col = position.col;
                this.row = position.row;
            }
        }

        return didMove;
    }

    _beginPointerGrab(actor) {
        if (this._pointerGrab) return true;

        try {
            this._pointerGrab = global.stage.grab(actor) ?? null;
        } catch (error) {
            console.warn(`[Widgets] No se pudo capturar el puntero durante la interacción: ${error.message}`);
        }

        return Boolean(this._pointerGrab);
    }

    _endPointerGrab() {
        const grab = this._pointerGrab;
        this._pointerGrab = null;
        if (!grab) return;

        try {
            grab.dismiss();
        } catch (error) {
            // The compositor may have revoked the grab already.
        }
    }

    _isGridRectAvailable(col, row, colSpan, rowSpan) {
        if (!this.grid.isValidCell(col, row, colSpan, rowSpan)) return false;

        const parent = this.get_parent();
        if (!parent) return true;

        return !parent.get_children().some(widget =>
            widget !== this && widget.grid === this.grid &&
            col < widget.col + widget.colSpan &&
            col + colSpan > widget.col &&
            row < widget.row + widget.rowSpan &&
            row + rowSpan > widget.row
        );
    }

    _findAvailablePosition(targetCol, targetRow) {
        let closest = null;
        let closestDistance = Infinity;

        for (let row = 0; row <= this.grid.rows - this.rowSpan; row++) {
            for (let col = 0; col <= this.grid.columns - this.colSpan; col++) {
                if (!this._isGridRectAvailable(col, row, this.colSpan, this.rowSpan)) continue;

                const distance = (col - targetCol) ** 2 + (row - targetRow) ** 2;
                if (distance < closestDistance) {
                    closest = { col, row };
                    closestDistance = distance;
                }
            }
        }

        return closest;
    }

    setCard(cardActor) {
        if (this._card) {
            this._disconnectCardContentClips();
            this.remove_child(this._card);
        }
        this._card = cardActor;
        this._card.reactive = false;
        // Clamp card content to the card bounds without clipping its own shadow.
        this._cardChildAddedId = this._card.connect('child-added', (_actor, child) => {
            this._trackCardContentChild(child);
        });
        this._cardChildRemovedId = this._card.connect('child-removed', (_actor, child) => {
            this._untrackCardContentChild(child);
        });
        this._cardAllocationId = this._card.connect('notify::allocation', () => {
            this._updateCardContentClips();
        });
        for (const child of this._card.get_children()) {
            this._trackCardContentChild(child);
        }

        if (this._blurWidget) {
            this.insert_child_above(this._card, this._blurWidget);
        } else {
            this.insert_child_at_index(this._card, 0);
        }

        if (this._adaptiveLabelsMappedId) {
            this.disconnect(this._adaptiveLabelsMappedId);
        }
        this._adaptiveLabelsMappedId = this.connect('notify::mapped', () => {
            if (!this.mapped || !this.get_stage()) return;

            this.disconnect(this._adaptiveLabelsMappedId);
            this._adaptiveLabelsMappedId = 0;
            this._adaptiveLabels.clear();
            this._collectAdaptiveLabels(this._card);
            this.updateGeometry();
        });

        this.updateGeometry();
    }

    _trackCardContentChild(child) {
        if (this._cardContentClipSignals.has(child)) return;

        const updateClip = () => this._updateCardContentClip(child);
        const signalIds = [
            child.connect('notify::allocation', updateClip),
            child.connect('notify::position', updateClip),
        ];
        this._cardContentClipSignals.set(child, signalIds);
        updateClip();
    }

    _untrackCardContentChild(child) {
        const signalIds = this._cardContentClipSignals.get(child) ?? [];
        for (const id of signalIds) {
            try {
                child.disconnect(id);
            } catch (_error) {
            }
        }
        this._cardContentClipSignals.delete(child);
        child.remove_clip();
    }

    _updateCardContentClips() {
        for (const child of this._cardContentClipSignals.keys()) {
            this._updateCardContentClip(child);
        }
    }

    _updateCardContentClip(child) {
        if (!this._card || child.get_parent() !== this._card) return;

        const [width, height] = this._card.get_size();
        if (width <= 0 || height <= 0) return;

        const [x, y] = child.get_position();
        child.set_clip(-x, -y, width, height);
    }

    _disconnectCardContentClips() {
        if (this._card) {
            for (const [signalId, field] of [
                [this._cardChildAddedId, '_cardChildAddedId'],
                [this._cardChildRemovedId, '_cardChildRemovedId'],
                [this._cardAllocationId, '_cardAllocationId'],
            ]) {
                if (!signalId) continue;
                try {
                    this._card.disconnect(signalId);
                } catch (_error) {
                }
                this[field] = 0;
            }
        }

        for (const child of this._cardContentClipSignals.keys()) {
            this._untrackCardContentChild(child);
        }
    }

    
    _createGauge(fillClass = '') {
        const track = new St.DrawingArea({
            style_class: 'widget-gauge-track',
            reactive: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const gauge = {
            track,
            value: 0,
            color: GAUGE_COLORS[fillClass] ?? GAUGE_COLORS['widget-gauge-blue'],
        };
        track.connect('repaint', () => this._drawGauge(gauge));
        this._layoutGauge(gauge);
        return gauge;
    }

    
    _setGauge(gauge, fraction, colorClass = 'widget-gauge-blue') {
        if (!gauge?.track) return;

        gauge.value = Math.max(0, Math.min(1, Number(fraction) || 0));
        gauge.color = GAUGE_COLORS[colorClass] ?? GAUGE_COLORS['widget-gauge-blue'];
        this._layoutGauge(gauge);
    }

    _layoutGauge(gauge) {
        if (!gauge?.track) return;

        gauge.track.queue_repaint();
    }

    _drawGauge(gauge) {
        const [width, height] = gauge.track.get_surface_size();
        if (width <= 0 || height <= 0) return;

        const context = gauge.track.get_context();
        try {
            context.setOperator(Cairo.Operator.CLEAR);
            context.paint();
            context.setOperator(Cairo.Operator.OVER);

            const fillWidth = Math.min(width, width * gauge.value);
            if (fillWidth <= 0) return;

            drawRoundedRect(context, fillWidth, height);
            context.setSourceRGBA(...gauge.color, 1);
            context.fill();
        } finally {
            context.$dispose();
        }
    }

    setBlurEnabled(enabled) {
        const next = Boolean(enabled);
        if (this._blurEnabled === next) {
            if ((this._blurEnabled || this._staticBlurEnabled) && !this._blurManager?.isActive) {
                this._updateBlurPresentation();
            }
            return;
        }
        this._blurEnabled = next;
        this._updateBlurPresentation();
    }

    setStaticBlurEnabled(enabled) {
        const next = Boolean(enabled);
        if (this._staticBlurEnabled === next) {
            if ((this._blurEnabled || this._staticBlurEnabled) && !this._blurManager?.isActive) {
                this._updateBlurPresentation();
            }
            return;
        }
        this._staticBlurEnabled = next;
        this._updateBlurPresentation();
    }

    _updateBlurPresentation() {
        const enabled = this._blurEnabled || this._staticBlurEnabled;
        if (enabled) {
            this._blurWidget?.show();
            if (this._staticBlurEnabled) {
                if (!this._blurManager?.isStatic) this._blurManager?.setStatic(true);
                else if (!this._blurManager?.isActive) this._blurManager?.apply();
            } else {
                const modeChanged = this._blurManager?.setStatic(false);
                if (!modeChanged && !this._blurManager?.isActive) this._blurManager?.apply();
            }
            this._card?.remove_style_class_name('no-blur');
        } else {
            this._blurManager?.remove();
            this._blurManager?.setStatic(false, false);
            this._blurWidget?.hide();
            this._card?.add_style_class_name('no-blur');
        }
    }

    
    animateToGrid(duration = 250) {
        if (!this.grid) return;

        const rect = this.grid.getCellRect(this.col, this.row, this.colSpan, this.rowSpan);

        this.save_easing_state();
        this.set_easing_duration(duration);
        this.set_easing_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);

        this.set_position(rect.x, rect.y);
        this.set_size(rect.width, rect.height);
        this.set_scale(1.0, 1.0);
        this.set_opacity(255);

        if (this._blurWidget) {
            this._blurWidget.save_easing_state();
            this._blurWidget.set_easing_duration(duration);
            this._blurWidget.set_easing_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            this._blurWidget.set_size(rect.width, rect.height);
            this._blurWidget.restore_easing_state();
        }

        if (this._card) {
            this._card.save_easing_state();
            this._card.set_easing_duration(duration);
            this._card.set_easing_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            this._card.set_size(rect.width, rect.height);
            this._card.restore_easing_state();
        }

        this._updateAdaptiveText(rect.width, rect.height);

        if (this._editOverlay) {
            this._editOverlay.save_easing_state();
            this._editOverlay.set_easing_duration(duration);
            this._editOverlay.set_easing_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            this._editOverlay.set_size(rect.width, rect.height);
            this._updateHandlePositions(rect.width, rect.height);
            this._editOverlay.restore_easing_state();
        }

        this.restore_easing_state();
        if (typeof this.onGeometryChanged === 'function') {
            this.onGeometryChanged();
        }
        if (this._staticBlurEnabled) this._blurManager?.scheduleStaticRefresh();
        this.emit('geometry-changed');
    }

    animateIntoGrid(duration = 420) {
        if (!this.grid) return;

        const rect = this.grid.getCellRect(this.col, this.row, this.colSpan, this.rowSpan);
        this.set_position(rect.x, rect.y + 18);
        this.set_scale(0.96, 0.96);
        this.set_opacity(0);
        this.animateToGrid(duration);
    }

    updateGeometry({ animate = false } = {}) {
        if (!this.grid) return;

        if (animate && this.get_stage()) {
            this.animateToGrid(420);
            return;
        }

        const rect = this.grid.getCellRect(this.col, this.row, this.colSpan, this.rowSpan);
        this.set_position(rect.x, rect.y);
        this.set_size(rect.width, rect.height);
        this.set_scale(1.0, 1.0);
        this.set_opacity(255);

        if (this._blurWidget) {
            this._blurWidget.set_position(0, 0);
            this._blurWidget.set_size(rect.width, rect.height);
        }

        if (this._card) {
            this._card.set_position(0, 0);
            this._card.set_size(rect.width, rect.height);
        }

        this._updateAdaptiveText(rect.width, rect.height);

        if (this._editOverlay) {
            this._editOverlay.set_position(0, 0);
            this._editOverlay.set_size(rect.width, rect.height);
            this._updateHandlePositions(rect.width, rect.height);
        }

        if (typeof this.onGeometryChanged === 'function') {
            this.onGeometryChanged();
        }
        if (this._staticBlurEnabled) this._blurManager?.scheduleStaticRefresh();
        this.emit('geometry-changed');
    }

    _collectAdaptiveLabels(actor) {
        if (actor instanceof St.Label && actor.get_stage()) {
            let baseSize = this._adaptiveLabelBaseSizes.get(actor);
            if (!baseSize) {
                const font = actor.get_theme_node()?.get_font();
                baseSize = font?.get_size() / Pango.SCALE;
                if (baseSize > 0) this._adaptiveLabelBaseSizes.set(actor, baseSize);
            }
            if (baseSize > 0) this._adaptiveLabels.set(actor, baseSize);
        }

        for (const child of actor.get_children()) {
            this._collectAdaptiveLabels(child);
        }
    }

    _updateAdaptiveText(width, height) {
        if (this._disableAdaptiveText || this._adaptiveLabels.size === 0 || !this.grid) return;

        const referenceWidth = this.grid.cellWidth * this._referenceColSpan + (this._referenceColSpan - 1) * this.grid.gapX;
        const referenceHeight = this.grid.cellHeight * this._referenceRowSpan + (this._referenceRowSpan - 1) * this.grid.gapY;
        const scale = Math.max(0.62, Math.min(1.7, Math.min(width / referenceWidth, height / referenceHeight)));

        for (const [label, baseSize] of this._adaptiveLabels) {
            label.set_style(`font-size: ${Math.round(baseSize * scale)}px;`);
        }
    }

    setEditMode(active) {
        if (this.isEditMode === active) return;
        this.isEditMode = active;

        if (this.isEditMode) {
            this._showEditOverlay();
        } else {
            this._hideEditOverlay();
        }

        this.save_easing_state();
        this.set_easing_duration(active ? 230 : 180);
        this.set_easing_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
        const scale = active ? 1.018 : 1.0;
        this.set_scale(scale, scale);
        this.restore_easing_state();
    }

    _showEditOverlay() {
        if (!this._editOverlay) {
            this._editOverlay = new Clutter.Actor({
                layout_manager: new Clutter.FixedLayout(),
                reactive: false,
            });

            this._selectionBorder = new St.Widget({
                style_class: 'widget-android-selection-border',
                reactive: false,
            });
            this._editOverlay.add_child(this._selectionBorder);

            if (this.resizable) {
                this._handleTop = this._createHandleDot('top');
                this._handleBottom = this._createHandleDot('bottom');
                this._handleLeft = this._createHandleDot('left');
                this._handleRight = this._createHandleDot('right');

                this._editOverlay.add_child(this._handleTop);
                this._editOverlay.add_child(this._handleBottom);
                this._editOverlay.add_child(this._handleLeft);
                this._editOverlay.add_child(this._handleRight);
            }

            this.add_child(this._editOverlay);
        }

        this._setEditHandlesReactive(true);
        this._updateHandlePositions(this.width, this.height);

        this._editOverlay.opacity = 0;
        this._editOverlay.show();
        this._editOverlay.save_easing_state();
        this._editOverlay.set_easing_duration(180);
        this._editOverlay.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
        this._editOverlay.set_opacity(255);
        this._editOverlay.restore_easing_state();

        const handles = [this._handleTop, this._handleRight, this._handleBottom, this._handleLeft]
            .filter(Boolean);
        handles.forEach((handle, index) => {
            handle.set_pivot_point(0.5, 0.5);
            handle.set_scale(0.65, 0.65);
            handle.opacity = 0;
            handle.save_easing_state();
            handle.set_easing_delay(index * 30);
            handle.set_easing_duration(230);
            handle.set_easing_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
            handle.set_scale(1.0, 1.0);
            handle.set_opacity(255);
            handle.restore_easing_state();
        });
    }

    _hideEditOverlay() {
        if (this._editOverlay) {
            this._setEditHandlesReactive(false);
            const handles = [this._handleLeft, this._handleBottom, this._handleRight, this._handleTop]
                .filter(Boolean);
            handles.forEach((handle, index) => {
                handle.save_easing_state();
                handle.set_easing_delay(index * 20);
                handle.set_easing_duration(120);
                handle.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
                handle.set_scale(0.7, 0.7);
                handle.set_opacity(0);
                handle.restore_easing_state();
            });
            this._editOverlay.save_easing_state();
            this._editOverlay.set_easing_duration(180);
            this._editOverlay.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
            this._editOverlay.set_opacity(0);
            this._editOverlay.restore_easing_state();

            if (this._hideOverlayTimeoutId) {
                GLib.source_remove(this._hideOverlayTimeoutId);
                this._hideOverlayTimeoutId = 0;
            }
            this._hideOverlayTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
                this._hideOverlayTimeoutId = 0;
                if (!this.isEditMode && this._editOverlay) {
                    this._editOverlay.hide();
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _setEditHandlesReactive(reactive) {
        for (const handle of [this._handleTop, this._handleBottom, this._handleLeft, this._handleRight]) {
            if (handle) handle.reactive = reactive;
        }
    }

    _updateHandlePositions(w, h) {
        if (!this._editOverlay) return;

        this._selectionBorder.set_position(0, 0);
        this._selectionBorder.set_size(w, h);
        if (!this.resizable) return;

        const dotRadius = 9;

        this._handleTop.set_position(Math.round(w / 2 - dotRadius), -dotRadius);
        this._handleBottom.set_position(Math.round(w / 2 - dotRadius), Math.round(h - dotRadius));
        this._handleLeft.set_position(-dotRadius, Math.round(h / 2 - dotRadius));
        this._handleRight.set_position(Math.round(w - dotRadius), Math.round(h / 2 - dotRadius));
    }

    _createHandleDot(direction) {
        const dot = new St.Widget({
            style_class: 'widget-android-handle-dot',
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: 18,
            height: 18,
        });

        let startPointer = null;
        let startGeometry = null;
        let isResizing = false;

        dot.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 1) {
                if (this._pointerGrab || this._isResizing) return Clutter.EVENT_STOP;

                const [x, y] = event.get_coords();
                this._beginPointerGrab(actor);
                startPointer = { x, y };
                startGeometry = { col: this.col, row: this.row, colSpan: this.colSpan, rowSpan: this.rowSpan };
                isResizing = false;
                this._isResizing = true;
                this._card?.add_style_class_name('widget-no-shadow');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        dot.connect('motion-event', (actor, event) => {
            if (!startPointer) return Clutter.EVENT_PROPAGATE;

            const [currX, currY] = event.get_coords();
            const dist = Math.hypot(currX - startPointer.x, currY - startPointer.y);
            if (dist >= POINTER_DRAG_THRESHOLD) {
                isResizing = true;
                this._onHandleDrag(direction, currX, currY, startGeometry);
            }
            return Clutter.EVENT_STOP;
        });

        dot.connect('button-release-event', (actor, event) => {
            if (startPointer && event.get_button() === 1) {
                const didResize = isResizing;
                this._isResizing = false;
                this._endPointerGrab();
                if (!didResize) {
                    this._onHandleClick(direction);
                } else {
                    this.animateToGrid(200);
                }
                this._card?.remove_style_class_name('widget-no-shadow');
                startPointer = null;
                startGeometry = null;
                isResizing = false;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return dot;
    }

    _onHandleDrag(direction, currX, currY, startGeom) {
        if (!this.grid) return;

        if (direction === 'right') {
            const relX = currX - (this.grid.startX + startGeom.col * (this.grid.cellWidth + this.grid.gapX));
            let newSpan = Math.round(relX / (this.grid.cellWidth + this.grid.gapX));
            newSpan = Math.max(this.minColSpan, Math.min(this.maxColSpan, newSpan));
            if (startGeom.col + newSpan <= this.grid.columns && newSpan !== this.colSpan &&
                this._isGridRectAvailable(this.col, this.row, newSpan, this.rowSpan)) {
                this.colSpan = newSpan;
                this.animateToGrid(110);
            }
        } else if (direction === 'bottom') {
            const relY = currY - (this.grid.startY + startGeom.row * (this.grid.cellHeight + this.grid.gapY));
            let newSpan = Math.round(relY / (this.grid.cellHeight + this.grid.gapY));
            newSpan = Math.max(this.minRowSpan, Math.min(this.maxRowSpan, newSpan));
            if (startGeom.row + newSpan <= this.grid.rows && newSpan !== this.rowSpan &&
                this._isGridRectAvailable(this.col, this.row, this.colSpan, newSpan)) {
                this.rowSpan = newSpan;
                this.animateToGrid(110);
            }
        } else if (direction === 'left') {
            const colStep = this.grid.cellWidth + this.grid.gapX;
            const targetCol = Math.round((currX - this.grid.startX) / colStep);
            const rightEdgeCol = startGeom.col + startGeom.colSpan;
            let newCol = Math.max(0, Math.min(rightEdgeCol - this.minColSpan, targetCol));
            let newSpan = rightEdgeCol - newCol;
            newSpan = Math.min(this.maxColSpan, newSpan);
            newCol = rightEdgeCol - newSpan;

            if ((newCol !== this.col || newSpan !== this.colSpan) &&
                this._isGridRectAvailable(newCol, this.row, newSpan, this.rowSpan)) {
                this.col = newCol;
                this.colSpan = newSpan;
                this.animateToGrid(110);
            }
        } else if (direction === 'top') {
            const rowStep = this.grid.cellHeight + this.grid.gapY;
            const targetRow = Math.round((currY - this.grid.startY) / rowStep);
            const bottomEdgeRow = startGeom.row + startGeom.rowSpan;
            let newRow = Math.max(0, Math.min(bottomEdgeRow - this.minRowSpan, targetRow));
            let newSpan = bottomEdgeRow - newRow;
            newSpan = Math.min(this.maxRowSpan, newSpan);
            newRow = bottomEdgeRow - newSpan;

            if ((newRow !== this.row || newSpan !== this.rowSpan) &&
                this._isGridRectAvailable(this.col, newRow, this.colSpan, newSpan)) {
                this.row = newRow;
                this.rowSpan = newSpan;
                this.animateToGrid(110);
            }
        }
    }

    _onHandleClick(direction) {
        const original = {
            col: this.col,
            row: this.row,
            colSpan: this.colSpan,
            rowSpan: this.rowSpan,
        };

        if (direction === 'right') {
            if (this.colSpan < this.maxColSpan && this.col + this.colSpan < this.grid.columns) {
                this.colSpan++;
            } else {
                this.colSpan = this.minColSpan;
            }
        } else if (direction === 'bottom') {
            if (this.rowSpan < this.maxRowSpan && this.row + this.rowSpan < this.grid.rows) {
                this.rowSpan++;
            } else {
                this.rowSpan = this.minRowSpan;
            }
        } else if (direction === 'left') {
            if (this.col > 0 && this.colSpan < this.maxColSpan) {
                this.col--;
                this.colSpan++;
            } else if (this.colSpan > this.minColSpan) {
                this.col++;
                this.colSpan--;
            }
        } else if (direction === 'top') {
            if (this.row > 0 && this.rowSpan < this.maxRowSpan) {
                this.row--;
                this.rowSpan++;
            } else if (this.rowSpan > this.minRowSpan) {
                this.row++;
                this.rowSpan--;
            }
        }
        if (!this._isGridRectAvailable(this.col, this.row, this.colSpan, this.rowSpan)) {
            Object.assign(this, original);
        }
        this.animateToGrid(220);
    }
});
