import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget } from '../core/baseWidget.js';

export const Widget = GObject.registerClass(
class PrototypeWidget extends BaseWidget {
    _init(params = {}) {
        super._init({
            grid: params.grid,
            col: params.col ?? 2,
            row: params.row ?? 1,
            colSpan: params.colSpan ?? 2,
            rowSpan: params.rowSpan ?? 2,
            minColSpan: params.minColSpan ?? 1,
            maxColSpan: params.maxColSpan ?? 6,
            minRowSpan: params.minRowSpan ?? 1,
            maxRowSpan: params.maxRowSpan ?? 4,
        });

        this._buildUI();
    }

    _buildUI() {
        const card = new St.BoxLayout({
            style_class: 'widget-card widget-prototype-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        const contentBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
            style_class: 'widget-content-box',
        });

        const tile = new St.BoxLayout({
            style_class: 'widget-proto-tile',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const icon = new St.Icon({
            icon_name: 'view-grid-symbolic',
            icon_size: 26,
            style_class: 'widget-icon',
        });
        tile.add_child(icon);
        contentBox.add_child(tile);

        const title = new St.Label({
            text: _('Prototype Widget'),
            style_class: 'widget-title',
        });
        contentBox.add_child(title);

        this._sizeBadge = new St.Label({
            text: `${this.colSpan} × ${this.rowSpan}`,
            style_class: 'widget-size-badge',
        });
        contentBox.add_child(this._sizeBadge);

        const hint = new St.Label({
            text: _('Right-click: Edit / Move'),
            style_class: 'widget-hint',
        });
        contentBox.add_child(hint);

        card.add_child(contentBox);
        this.setCard(card);

        this.connect('geometry-changed', () => {
            if (this._sizeBadge) {
                this._sizeBadge.text = `${this.colSpan} × ${this.rowSpan}`;
            }
        });
    }
});

export const WIDGET_CONFIG = {
    col: 0,
    row: 3,
    colSpan: 2,
    rowSpan: 2,
    minColSpan: 1,
    maxColSpan: 6,
    minRowSpan: 1,
    maxRowSpan: 4,
};

export function getWidgetMetadata() {
    return {
        name: _('Prototype widget'),
        description: _('Shows widget size and editing instructions.'),
    };
}

export const WIDGET_NAME = 'Prototype widget';
export const WIDGET_DESCRIPTION = 'Shows widget size and editing instructions.';
