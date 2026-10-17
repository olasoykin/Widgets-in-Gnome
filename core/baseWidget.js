import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { BlurManager } from './blur.js';

const GAUGE_COLOR_CLASSES = [
    'widget-gauge-blue',
    'widget-gauge-green',
    'widget-gauge-orange',
    'widget-gauge-red',
];

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
        this._adaptiveLabels = new Map();
        this._referenceColSpan = this.colSpan;
        this._referenceRowSpan = this.rowSpan;

        this.isEditMode = false;
        this._isDraggingWidget = false;
        this._isResizing = false;

        this._blurWidget = new St.Widget({
            style_class: 'widget-blur-surface',
            reactive: false,
        });
        this.insert_child_at_index(this._blurWidget, 0);

        this._blurManager = new BlurManager(this._blurWidget, {
            cornerRadius: 28,
        });

        this.connect('destroy', () => {
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
        let grabOffsetX = 0;
        let grabOffsetY = 0;
        let hasMoved = false;

        this.connect('button-press-event', (actor, event) => {
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

            if (button === 1 && this.isEditMode) {
                const [stageX, stageY] = event.get_coords();
                grabOffsetX = stageX - this.x;
                grabOffsetY = stageY - this.y;
                hasMoved = false;
                this._isDraggingWidget = true;
                this._card?.add_style_class_name('widget-no-shadow');

                this.save_easing_state();
                this.set_easing_duration(150);
                this.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
                this.set_scale(1.04, 1.04);
                this.set_opacity(230);
                this.restore_easing_state();

                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        this.connect('motion-event', (actor, event) => {
            if (!this._isDraggingWidget) return Clutter.EVENT_PROPAGATE;

            const [stageX, stageY] = event.get_coords();
            const newX = stageX - grabOffsetX;
            const newY = stageY - grabOffsetY;

            hasMoved = true;
            this.set_position(newX, newY);
            return Clutter.EVENT_STOP;
        });

        this.connect('button-release-event', (actor, event) => {
            if (this._isDraggingWidget) {
                this._isDraggingWidget = false;

                if (hasMoved) {
                    const colStep = this.grid.cellWidth + this.grid.gapX;
                    const rowStep = this.grid.cellHeight + this.grid.gapY;

                    const relX = this.x - this.grid.startX;
                    const relY = this.y - this.grid.startY;

                    let targetCol = Math.round(relX / colStep);
                    let targetRow = Math.round(relY / rowStep);

                    targetCol = Math.max(0, Math.min(this.grid.columns - this.colSpan, targetCol));
                    targetRow = Math.max(0, Math.min(this.grid.rows - this.rowSpan, targetRow));

                    const position = this._findAvailablePosition(targetCol, targetRow);
                    if (position) {
                        this.col = position.col;
                        this.row = position.row;
                    }
                }

                this.animateToGrid(280);
                this._card?.remove_style_class_name('widget-no-shadow');
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });
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
            this.remove_child(this._card);
        }
        this._card = cardActor;
        this._card.reactive = false;

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

    
    _createGauge(fillClass = '') {
        const track = new St.BoxLayout({
            style_class: 'widget-gauge-track',
            reactive: false,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const fill = new St.Widget({
            style_class: fillClass ? `widget-gauge-fill ${fillClass}` : 'widget-gauge-fill',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        fill.height = 10;
        track.add_child(fill);

        const gauge = { track, fill, value: 0 };
        track.connect('notify::allocation', () => this._layoutGauge(gauge));
        this._layoutGauge(gauge);
        return gauge;
    }

    
    _setGauge(gauge, fraction, colorClass = 'widget-gauge-blue') {
        if (!gauge?.fill) return;

        gauge.value = Math.max(0, Math.min(1, Number(fraction) || 0));
        for (const name of GAUGE_COLOR_CLASSES) {
            gauge.fill.remove_style_class_name(name);
        }
        gauge.fill.add_style_class_name(colorClass);
        this._layoutGauge(gauge);
    }

    _layoutGauge(gauge) {
        if (!gauge?.track || !gauge.fill) return;
        if (!gauge.track.get_stage()) return;

        const trackWidth = gauge.track.width;
        if (trackWidth <= 0) return;

        gauge.fill.set_width(Math.round(trackWidth * gauge.value));
    }

    setBlurEnabled(enabled) {
        if (enabled) {
            this._blurWidget?.show();
            this._blurManager?.apply();
            this._card?.remove_style_class_name('no-blur');
        } else {
            this._blurManager?.remove();
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
        this.emit('geometry-changed');
    }

    updateGeometry() {
        if (!this.grid) return;

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
        this.emit('geometry-changed');
    }

    _collectAdaptiveLabels(actor) {
        if (actor instanceof St.Label && actor.get_stage()) {
            const font = actor.get_theme_node()?.get_font();
            const fontSize = font?.get_size() / Pango.SCALE;
            if (fontSize > 0) this._adaptiveLabels.set(actor, fontSize);
        }

        for (const child of actor.get_children()) {
            this._collectAdaptiveLabels(child);
        }
    }

    _updateAdaptiveText(width, height) {
        if (this._adaptiveLabels.size === 0 || !this.grid) return;

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

        this._updateHandlePositions(this.width, this.height);

        this._editOverlay.opacity = 0;
        this._editOverlay.show();
        this._editOverlay.save_easing_state();
        this._editOverlay.set_easing_duration(180);
        this._editOverlay.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
        this._editOverlay.set_opacity(255);
        this._editOverlay.restore_easing_state();
    }

    _hideEditOverlay() {
        if (this._editOverlay) {
            this._editOverlay.save_easing_state();
            this._editOverlay.set_easing_duration(150);
            this._editOverlay.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
            this._editOverlay.set_opacity(0);
            this._editOverlay.restore_easing_state();

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                if (!this.isEditMode && this._editOverlay) {
                    this._editOverlay.hide();
                }
                return GLib.SOURCE_REMOVE;
            });
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
                const [x, y] = event.get_coords();
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
            if (dist > 8) {
                isResizing = true;
                this._onHandleDrag(direction, currX, currY, startGeometry);
            }
            return Clutter.EVENT_STOP;
        });

        dot.connect('button-release-event', (actor, event) => {
            if (startPointer) {
                this._isResizing = false;
                if (!isResizing) {
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
