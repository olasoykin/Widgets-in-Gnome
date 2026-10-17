import Cairo from 'gi://cairo';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

const TAU = Math.PI * 2;
const NUMERAL_ANGLES = [
    { text: '12', angle: -Math.PI / 2 },
    { text: '3', angle: 0 },
    { text: '6', angle: Math.PI / 2 },
    { text: '9', angle: Math.PI },
];

const PREFERRED_FONTS = ['SF Pro Display', 'SF Pro Text', 'Inter', 'Cantarell', 'DejaVu Sans'];
let cachedFontFamily = null;

const DARK_PALETTE = {
    dialInner: [0.17, 0.17, 0.19, 1],
    dialOuter: [0.04, 0.04, 0.05, 1],
    bezel: [1, 1, 1, 0.16],
    hourTick: [1, 1, 1, 0.95],
    minuteTick: [1, 1, 1, 0.32],
    numeral: [1, 1, 1, 0.92],
    hand: [1, 1, 1, 1],
    handShadow: [0, 0, 0, 0.55],
    accent: [1, 0.58, 0.04, 1],
};

const LIGHT_PALETTE = {
    dialInner: [1, 1, 1, 1],
    dialOuter: [0.93, 0.93, 0.94, 1],
    bezel: [0, 0, 0, 0.14],
    hourTick: [0.07, 0.07, 0.08, 0.92],
    minuteTick: [0, 0, 0, 0.26],
    numeral: [0.07, 0.07, 0.08, 0.92],
    hand: [0.09, 0.09, 0.10, 1],
    handShadow: [0, 0, 0, 0.24],
    accent: [1, 0.42, 0, 1],
};

export function getAnalogClockPalette(isDark = true) {
    return isDark ? DARK_PALETTE : LIGHT_PALETTE;
}

function _pickFontFamily() {
    if (cachedFontFamily) return cachedFontFamily;
    try {
        const fontMap = PangoCairo.font_map_get_default();
        const available = fontMap.list_families().map(family => family.get_name());
        cachedFontFamily = PREFERRED_FONTS.find(name => available.includes(name)) ?? 'Cantarell';
    } catch (_error) {
        cachedFontFamily = 'Cantarell';
    }
    return cachedFontFamily;
}

function _showLayout(context, layout) {
    if (typeof PangoCairo.show_layout === 'function')
        PangoCairo.show_layout(context, layout);
    else if (typeof Pango.cairo_show_layout === 'function')
        Pango.cairo_show_layout(context, layout);
}

function _drawDial(context, centerX, centerY, radius, palette) {
    const gradient = new Cairo.RadialGradient(
        centerX, centerY - radius * 0.25, radius * 0.05,
        centerX, centerY, radius
    );
    gradient.addColorStopRGBA(0, ...palette.dialInner);
    gradient.addColorStopRGBA(1, ...palette.dialOuter);

    context.newPath();
    context.arc(centerX, centerY, radius, 0, TAU);
    context.setSource(gradient);
    context.fillPreserve();
    context.setLineWidth(Math.max(1, radius * 0.022));
    context.setSourceRGBA(...palette.bezel);
    context.stroke();
    context.newPath();
}

function _drawTicks(context, centerX, centerY, radius, palette) {
    const outer = radius * 0.90;
    context.setLineCap(Cairo.LineCap.ROUND);

    context.newPath();
    for (let tick = 0; tick < 60; tick++) {
        if (tick % 5 === 0) continue;
        const angle = tick * TAU / 60 - Math.PI / 2;
        const inner = outer - radius * 0.05;
        context.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner);
        context.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer);
    }
    context.setLineWidth(Math.max(1, radius * 0.013));
    context.setSourceRGBA(...palette.minuteTick);
    context.stroke();

    context.newPath();
    for (let tick = 0; tick < 12; tick++) {
        const angle = tick * TAU / 12 - Math.PI / 2;
        const inner = outer - radius * 0.115;
        context.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner);
        context.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer);
    }
    context.setLineWidth(Math.max(2, radius * 0.034));
    context.setSourceRGBA(...palette.hourTick);
    context.stroke();
    context.newPath();
}

function _drawNumerals(context, centerX, centerY, radius, palette, scale) {
    const fontSize = Math.round(radius * 0.30 * scale);
    if (fontSize < 8) return;

    const distance = radius * 0.62;
    for (const { text, angle } of NUMERAL_ANGLES) {
        const layout = PangoCairo.create_layout(context);
        const description = Pango.FontDescription.from_string(`${_pickFontFamily()} ${fontSize}`);
        description.set_weight(Pango.Weight.SEMIBOLD);
        description.set_size(Math.round(fontSize * 0.75 * Pango.SCALE));
        layout.set_font_description(description);
        layout.set_text(text, -1);

        const [textWidth, textHeight] = layout.get_pixel_size();
        const x = centerX + Math.cos(angle) * distance - textWidth / 2;
        const y = centerY + Math.sin(angle) * distance - textHeight / 2;

        context.newPath();
        context.moveTo(x, y);
        context.setSourceRGBA(...palette.numeral);
        _showLayout(context, layout);
    }
    context.newPath();
}

function _drawBar(context, centerX, centerY, angle, from, to, lineWidth, color, offsetY = 0) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    context.newPath();
    context.moveTo(centerX + dx * from, centerY + dy * from + offsetY);
    context.lineTo(centerX + dx * to, centerY + dy * to + offsetY);
    context.setLineWidth(lineWidth);
    context.setLineCap(Cairo.LineCap.ROUND);
    context.setSourceRGBA(...color);
    context.stroke();
}

function _drawHands(context, centerX, centerY, radius, palette, hours, minutes, seconds) {
    const hourAngle = hours * TAU / 12 - Math.PI / 2;
    const minuteAngle = minutes * TAU / 60 - Math.PI / 2;
    const secondAngle = seconds * TAU / 60 - Math.PI / 2;

    const hourWidth = Math.max(3, radius * 0.075);
    const minuteWidth = Math.max(2.5, radius * 0.055);
    const secondWidth = Math.max(1.5, radius * 0.018);
    const shadowOffset = Math.max(1, radius * 0.02);

    const hourTail = -radius * 0.07;
    const minuteTail = -radius * 0.09;

    _drawBar(context, centerX, centerY, hourAngle, hourTail, radius * 0.50,
        hourWidth, palette.handShadow, shadowOffset);
    _drawBar(context, centerX, centerY, minuteAngle, minuteTail, radius * 0.72,
        minuteWidth, palette.handShadow, shadowOffset);
    _drawBar(context, centerX, centerY, hourAngle, hourTail, radius * 0.50,
        hourWidth, palette.hand);
    _drawBar(context, centerX, centerY, minuteAngle, minuteTail, radius * 0.72,
        minuteWidth, palette.hand);

    _drawBar(context, centerX, centerY, secondAngle, -radius * 0.24, radius * 0.80,
        secondWidth, palette.handShadow, shadowOffset * 0.5);
    _drawBar(context, centerX, centerY, secondAngle, -radius * 0.24, radius * 0.80,
        secondWidth, palette.accent);

    context.newPath();
    context.arc(centerX, centerY, Math.max(3, radius * 0.055), 0, TAU);
    context.setSourceRGBA(...palette.hand);
    context.fill();
    context.arc(centerX, centerY, Math.max(1.5, radius * 0.026), 0, TAU);
    context.setSourceRGBA(...palette.accent);
    context.fill();
    context.newPath();
}

/**
 * Dibuja una esfera de reloj analógica adaptada al tema (clara u oscura).
 *
 * @param {Cairo.Context} context contexto cairo de St.DrawingArea
 * @param {number} width ancho del área de dibujo
 * @param {number} height alto del área de dibujo
 * @param {object} [options] { isDark, now, scale }
 */
export function drawAnalogClockFace(context, width, height, options = {}) {
    const {
        isDark = true,
        now = GLib.DateTime.new_now_local(),
        scale = 1,
    } = options;

    const size = Math.min(width, height);
    const radius = size / 2 - Math.max(4, size * 0.02);
    if (radius <= 0) return;

    const palette = getAnalogClockPalette(isDark);
    const centerX = width / 2;
    const centerY = height / 2;

    const seconds = now.get_second();
    const minutes = now.get_minute() + seconds / 60;
    const hours = (now.get_hour() % 12) + minutes / 60;

    _drawDial(context, centerX, centerY, radius, palette);
    _drawTicks(context, centerX, centerY, radius, palette);
    if (radius >= 45)
        _drawNumerals(context, centerX, centerY, radius, palette, scale);
    _drawHands(context, centerX, centerY, radius, palette, hours, minutes, seconds);
}


