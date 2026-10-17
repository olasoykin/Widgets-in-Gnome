import St from 'gi://St';
import Gio from 'gi://Gio';

const TMP_CSS_PATH = '/tmp/widgets-inter-fonts.css';

/** @type {Gio.File | null} */
let _loadedStylesheet = null;

/**
 * Registra dinámicamente la fuente Inter variable en el St.Theme activo de GNOME Shell.
 * @param {string} extensionPath - Ruta base de la extensión
 */
export function registerFonts(extensionPath) {
    if (_loadedStylesheet) return;

    const fontsDir = `${extensionPath}/fonts`;
    const css = _buildFontFaceCSS(fontsDir);
    if (!css) return;

    try {
        const tmpFile = Gio.File.new_for_path(TMP_CSS_PATH);
        const [ok] = tmpFile.replace_contents(
            new TextEncoder().encode(css),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
        if (!ok) {
            console.warn('[Widgets] fontLoader: fallo al escribir CSS temporal');
            return;
        }
        _loadedStylesheet = tmpFile;
    } catch (e) {
        console.warn('[Widgets] fontLoader: error al escribir CSS —', e.message);
        return;
    }

    try {
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        theme.load_stylesheet(_loadedStylesheet);
    } catch (e) {
        console.warn('[Widgets] fontLoader: fallo al cargar stylesheet —', e.message);
        _loadedStylesheet = null;
    }
}

/**
 * Descarga el stylesheet de fuentes al deshabilitar la extensión.
 */
export function unregisterFonts() {
    if (!_loadedStylesheet) return;
    try {
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        theme.unload_stylesheet(_loadedStylesheet);
    } catch (e) {
        console.warn('[Widgets] fontLoader: fallo al descargar stylesheet —', e.message);
    }

    try {
        _loadedStylesheet.delete(null);
    } catch {
        // Ignorar si ya fue eliminado
    }
    _loadedStylesheet = null;
}

function _buildFontFaceCSS(fontsDir) {
    let fontPath = `${fontsDir}/Inter.ttf`;
    if (!Gio.File.new_for_path(fontPath).query_exists(null)) {
        fontPath = `${fontsDir}/Inter-VariableFont_opsz,wght.ttf`;
        if (!Gio.File.new_for_path(fontPath).query_exists(null)) {
            console.warn('[Widgets] fontLoader: Inter no encontrada en', fontsDir);
            return null;
        }
    }

    return `/* Generado por fontLoader.js */
@font-face {
    font-family: "Inter";
    font-style: normal;
    font-weight: 100 900;
    src: url("file://${fontPath}") format("truetype");
}

@font-face {
    font-family: "Inter";
    font-style: italic;
    font-weight: 100 900;
    src: url("file://${fontPath}") format("truetype");
}
`;
}
