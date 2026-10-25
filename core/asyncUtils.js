import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function readTextFileAsync(path, cancellable = null) {
    return new Promise((resolve, reject) => {
        try {
            const file = Gio.File.new_for_path(path);
            file.load_contents_async(cancellable, (source, result) => {
                try {
                    const [, contents] = source.load_contents_finish(result);
                    resolve(new TextDecoder().decode(contents));
                } catch (error) {
                    reject(error);
                }
            });
        } catch (error) {
            reject(error);
        }
    });
}

export function writeTextFileAsync(path, text, cancellable = null) {
    return new Promise((resolve, reject) => {
        try {
            const dir = GLib.path_get_dirname(path);
            GLib.mkdir_with_parents(dir, 0o700);
            const file = Gio.File.new_for_path(path);
            const bytes = new TextEncoder().encode(text);
            file.replace_contents_bytes_async(
                new GLib.Bytes(bytes),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                cancellable,
                (source, result) => {
                    try {
                        source.replace_contents_finish(result);
                        resolve(true);
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        } catch (error) {
            reject(error);
        }
    });
}

export async function readJsonFileAsync(path, cancellable = null) {
    try {
        const text = await readTextFileAsync(path, cancellable);
        return JSON.parse(text);
    } catch (_error) {
        return null;
    }
}

export async function writeJsonFileAsync(path, data, cancellable = null) {
    try {
        const text = JSON.stringify(data, null, 2);
        return await writeTextFileAsync(path, text, cancellable);
    } catch (_error) {
        return false;
    }
}

export function queryFilesystemInfoAsync(path, attributes = 'filesystem::size,filesystem::free,filesystem::type', cancellable = null) {
    return new Promise(resolve => {
        try {
            const file = Gio.File.new_for_path(path);
            file.query_filesystem_info_async(attributes, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                try {
                    const info = source.query_filesystem_info_finish(result);
                    resolve(info);
                } catch (_error) {
                    resolve(null);
                }
            });
        } catch (_error) {
            resolve(null);
        }
    });
}

export function trashFileAsync(file, cancellable = null) {
    return new Promise((resolve, reject) => {
        try {
            file.trash_async(GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                try {
                    const ok = source.trash_finish(result);
                    resolve(ok);
                } catch (error) {
                    reject(error);
                }
            });
        } catch (error) {
            reject(error);
        }
    });
}
