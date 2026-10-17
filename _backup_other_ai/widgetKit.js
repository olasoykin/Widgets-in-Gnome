import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

export const ACCENTS = ['blue', 'green', 'orange', 'red', 'purple'];

const ICONS_DIR = Gio.File.new_for_uri(import.meta.url)
    .get_parent()
    .get_parent()
    .get_child('icons');

const _iconCache = new Map();


function _loadIcon(name, fallback) {
    const key = `${name}|${fallback}`;
    if (_iconCache.has(key)) return _iconCache.get(key);

    const file = ICONS_DIR.get_child(`${name}-symbolic.svg`);
    const gicon = file.query_exists(null)
        ? new Gio.FileIcon({ file })
        : new Gio.ThemedIcon({ name: fallback });

    _iconCache.set(key, gicon);
    return gicon;
}

export function capitalize(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

export function createIcon(name, fallback, { size = 16, styleClass = '' } = {}) {
    const icon = new St.Icon({
        gicon: _loadIcon(name, fallback),
        icon_size: size,
        style_class: `wx-icon ${styleClass}`.trim(),
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    icon._wxName = name;
    return icon;
}

export function setIcon(icon, name, fallback) {
    if (!icon || icon._wxName === name) return;
    icon._wxName = name;
    icon.gicon = _loadIcon(name, fallback);
}


export function setAccentClass(actor, prefix, accent) {
    if (!actor) return;
    for (const name of ACCENTS) actor.remove_style_class_name(`${prefix}-${name}`);
    actor.add_style_class_name(`${prefix}-${accent}`);
}


export function createHeader({ title, icon, fallback, accent }) {
    const row = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        style_class: 'wx-header',
        x_expand: true,
        x_align: Clutter.ActorAlign.FILL,
    });

    const chip = new St.Bin({
        style_class: `wx-chip wx-chip-${accent}`,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const iconActor = createIcon(icon, fallback, { size: 15, styleClass: 'wx-chip-icon' });
    chip.set_child(iconActor);

    const caption = new St.Label({
        text: title,
        style_class: `wx-caption wx-text-${accent}`,
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const side = new St.Label({
        text: '',
        style_class: 'wx-header-side',
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
    });

    row.add_child(chip);
    row.add_child(caption);
    row.add_child(side);

    return { row, chip, icon: iconActor, caption, side };
}


export function createRing() {
    const area = new St.DrawingArea({
        style_class: 'wx-ring wx-ring-blue',
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.FILL,
    });

    const ring = { actor: area, value: 0 };
    area.connect('repaint', () => _paintRing(area, ring.value));
    area.connect('style-changed', () => area.queue_repaint());
    return ring;
}

export function setRing(ring, fraction, accent = 'blue') {
    if (!ring) return;
    ring.value = Math.max(0, Math.min(1, Number(fraction) || 0));
    setAccentClass(ring.actor, 'wx-ring', accent);
    ring.actor.queue_repaint();
}


export function createRingStack(ring, center) {
    const stack = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        style_class: 'wx-ring-stack',
        x_expand: true,
        y_expand: true,
        x_align: Clutter.ActorAlign.FILL,
        y_align: Clutter.ActorAlign.FILL,
    });

    center.x_expand = true;
    center.y_expand = true;
    center.x_align = Clutter.ActorAlign.CENTER;
    center.y_align = Clutter.ActorAlign.CENTER;

    stack.add_child(ring.actor);
    stack.add_child(center);
    return stack;
}

function _paintRing(area, value) {
    const [width, height] = area.get_surface_size();
    const size = Math.min(width, height);
    if (size <= 0) return;

    const cr = area.get_context();
    try {
        const color = area.get_theme_node().get_foreground_color();
        const r = color.red / 255;
        const g = color.green / 255;
        const b = color.blue / 255;

        const line = Math.max(5, Math.round(size * 0.12));
        const radius = (size - line) / 2;
        const cx = width / 2;
        const cy = height / 2;
        const start = -Math.PI / 2;

        cr.setLineWidth(line);
        cr.setLineCap(1);

        cr.setSourceRGBA(r, g, b, 0.22);
        cr.arc(cx, cy, radius, 0, Math.PI * 2);
        cr.stroke();

        if (value > 0) {
            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(cx, cy, radius, start, start + Math.PI * 2 * Math.min(value, 0.9999));
            cr.stroke();
        }
    } finally {
        cr.$dispose();
    }
}
