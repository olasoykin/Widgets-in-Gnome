import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

let _loadedStylesheet = null;

function _getCssPath() {
    return GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        'widgets@kin',
        'widgets-inter-fonts.css',
    ]);
}

export function registerFonts(extensionPath) {
    if (_loadedStylesheet) return;

    const fontsDir = `${extensionPath}/fonts`;
    const css = _buildFontFaceCSS(fontsDir);
    if (!css) return;

    try {
        const cssPath = _getCssPath();
        GLib.mkdir_with_parents(GLib.path_get_dirname(cssPath), 0o700);
        const tmpFile = Gio.File.new_for_path(cssPath);
        const [ok] = tmpFile.replace_contents(
            new TextEncoder().encode(css),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
        if (!ok) return;
        _loadedStylesheet = tmpFile;
    } catch (e) {
        console.warn(`[Widgets] fontLoader: failed to write CSS — ${e.message}`);
        return;
    }

    try {
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        theme.load_stylesheet(_loadedStylesheet);
    } catch (e) {
        console.warn(`[Widgets] fontLoader: failed to load stylesheet — ${e.message}`);
        _loadedStylesheet = null;
    }
}

export function unregisterFonts() {
    if (!_loadedStylesheet) return;
    try {
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        theme.unload_stylesheet(_loadedStylesheet);
    } catch (e) {
        console.warn(`[Widgets] fontLoader: failed to unload stylesheet — ${e.message}`);
    }

    try {
        _loadedStylesheet.delete(null);
    } catch {}
    _loadedStylesheet = null;
}

function _buildFontFaceCSS(fontsDir) {
    let fontPath = `${fontsDir}/Inter.ttf`;
    if (!Gio.File.new_for_path(fontPath).query_exists(null)) {
        fontPath = `${fontsDir}/Inter-VariableFont_opsz,wght.ttf`;
        if (!Gio.File.new_for_path(fontPath).query_exists(null)) {
            return null;
        }
    }

    let italicFontPath = `${fontsDir}/Inter-Italic.ttf`;
    if (!Gio.File.new_for_path(italicFontPath).query_exists(null)) {
        italicFontPath = `${fontsDir}/Inter-Italic-VariableFont_opsz,wght.ttf`;
        if (!Gio.File.new_for_path(italicFontPath).query_exists(null)) {
            italicFontPath = fontPath;
        }
    }

    return `@font-face {
    font-family: "Inter";
    font-style: normal;
    font-weight: 100 900;
    src: url("file://${fontPath}") format("truetype");
}

@font-face {
    font-family: "Inter";
    font-style: italic;
    font-weight: 100 900;
    src: url("file://${italicFontPath}") format("truetype");
}
`;
}
