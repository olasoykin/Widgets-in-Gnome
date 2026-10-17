import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const GridOverlay = GObject.registerClass(
class GridOverlay extends Clutter.Actor {
    _init(grid) {
        super._init({
            reactive: false,
            layout_manager: new Clutter.FixedLayout(),
        });

        this.grid = grid;
        this.render();
    }

    render() {
        this.destroy_all_children();

        const { rows, columns, monitor } = this.grid;

        this.set_position(0, 0);
        this.set_size(monitor.width, monitor.height);

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < columns; c++) {
                const rect = this.grid.getCellRect(c, r, 1, 1);

                const cell = new St.Widget({
                    style_class: 'widget-grid-cell',
                    reactive: false,
                    can_focus: false,
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                });

                const label = new St.Label({
                    style_class: 'widget-grid-cell-label',
                    text: `${c},${r}`,
                    x_align: Clutter.ActorAlign.START,
                    y_align: Clutter.ActorAlign.START,
                });

                cell.add_child(label);
                this.add_child(cell);
            }
        }
    }
});
