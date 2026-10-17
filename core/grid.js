
export class Grid {
    constructor(params = {}) {
        this.rows = params.rows ?? 7;
        this.margin = params.margin ?? 16;
        this.approxGap = params.gap ?? 12;
        this.topOffset = params.topOffset ?? 36;

        this.monitor = {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            ...(params.monitor ?? {}),
        };

        this._recalculate();
    }

    updateConfig({ rows, margin, gap, topOffset, monitor }) {
        if (rows !== undefined) this.rows = Math.max(3, rows);
        if (margin !== undefined) this.margin = Math.max(0, margin);
        if (gap !== undefined) this.approxGap = Math.max(2, gap);
        if (topOffset !== undefined) this.topOffset = Math.max(0, topOffset);
        if (monitor) this.monitor = { ...this.monitor, ...monitor };

        this._recalculate();
    }

    _recalculate() {
        const W_net = this.monitor.width - 2 * this.margin;
        const H_net = (this.monitor.height - this.topOffset) - 2 * this.margin;

        const P = (H_net + this.approxGap) / this.rows;

        this.columns = Math.max(3, Math.round((W_net + this.approxGap) / P));

        const S = Math.round((H_net - (this.rows - 1) * this.approxGap) / this.rows);
        this.cellWidth = Math.max(10, S);
        this.cellHeight = Math.max(10, S);

        this.gapX = this.columns > 1 ? (W_net - this.columns * this.cellWidth) / (this.columns - 1) : 0;
        this.gapY = this.rows > 1 ? (H_net - this.rows * this.cellHeight) / (this.rows - 1) : 0;

        this.startX = this.monitor.x + this.margin;
        this.startY = this.monitor.y + this.topOffset + this.margin;
    }

    
    getCellRect(col, row, colSpan = 1, rowSpan = 1) {
        const cSpan = Math.max(1, colSpan);
        const rSpan = Math.max(1, rowSpan);

        const x = this.startX + col * (this.cellWidth + this.gapX);
        const y = this.startY + row * (this.cellHeight + this.gapY);

        const width = cSpan * this.cellWidth + (cSpan - 1) * this.gapX;
        const height = rSpan * this.cellHeight + (rSpan - 1) * this.gapY;

        return {
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height),
        };
    }

    
    pointToCell(x, y) {
        const colStep = this.cellWidth + this.gapX;
        const rowStep = this.cellHeight + this.gapY;

        const relX = x - this.startX;
        const relY = y - this.startY;

        let col = Math.round(relX / colStep);
        let row = Math.round(relY / rowStep);

        col = Math.max(0, Math.min(this.columns - 1, col));
        row = Math.max(0, Math.min(this.rows - 1, row));

        return { col, row };
    }

    isValidCell(col, row, colSpan = 1, rowSpan = 1) {
        return (
            col >= 0 &&
            row >= 0 &&
            col + colSpan <= this.columns &&
            row + rowSpan <= this.rows
        );
    }
}
