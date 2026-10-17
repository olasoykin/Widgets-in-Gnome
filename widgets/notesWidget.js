import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { BaseWidget, configureWidgetCaption } from '../core/baseWidget.js';
import { createIcon } from '../core/icons.js';

const EMPTY_HINT = _('Edit the notes file to see them here');

export const Widget = GObject.registerClass(
class NotesWidget extends BaseWidget {
    _init(params = {}) {
        super._init({
            ...params,
            colSpan: params.colSpan ?? 2,
            rowSpan: params.rowSpan ?? 2,
        });

        this._notesPath = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            'widgets@kin',
            'notes.txt',
        ]);

        this._buildUI();
        this._loadNotes();
        this._watchNotesFile();

        this.connect('destroy', () => {
            if (this._monitor) {
                this._monitor.cancel();
                this._monitor = null;
            }
        });
    }

    _buildUI() {
        const card = new St.BoxLayout({
            style_class: 'widget-card widget-common-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        const contentBox = new St.BoxLayout({
            style_class: 'widget-content-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
        });

        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'widget-header',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        const caption = configureWidgetCaption(new St.Label({
            text: _('Notes').toUpperCase(),
            style_class: 'widget-caption',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
        }));
        header.add_child(createIcon('notebook', 14));
        header.add_child(caption);

        this._notesLabel = new St.Label({
            text: '',
            style_class: 'widget-notes-text',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        const clutterText = this._notesLabel.get_clutter_text();
        clutterText.line_wrap = true;
        clutterText.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        clutterText.ellipsize = Pango.EllipsizeMode.NONE;

        contentBox.add_child(header);
        contentBox.add_child(this._notesLabel);
        card.add_child(contentBox);
        this.setCard(card);
    }

    _loadNotes() {
        try {
            const file = Gio.File.new_for_path(this._notesPath);
            if (!file.query_exists(null)) {
                GLib.mkdir_with_parents(GLib.path_get_dirname(this._notesPath), 0o700);
                file.replace_contents('', null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                this._notesLabel.text = EMPTY_HINT;
                this._notesLabel.add_style_class_name('widget-notes-empty');
                return;
            }

            const [, contents] = file.load_contents(null);
            const text = new TextDecoder().decode(contents).trim();
            if (text.length === 0) {
                this._notesLabel.text = EMPTY_HINT;
                this._notesLabel.add_style_class_name('widget-notes-empty');
            } else {
                this._notesLabel.text = text;
                this._notesLabel.remove_style_class_name('widget-notes-empty');
            }
        } catch (error) {
            this._notesLabel.text = _('Could not read the notes file');
            console.warn(`[Widgets] Notes: ${error.message}`);
        }
    }

    _watchNotesFile() {
        try {
            const file = Gio.File.new_for_path(this._notesPath);
            this._monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._loadNotes());
        } catch (error) {
            console.warn(`[Widgets] Could not monitor notes: ${error.message}`);
        }
    }
});

export const WIDGET_CONFIG = { colSpan: 2, rowSpan: 3 };
export const WIDGET_NAME = _('Notes');
export const WIDGET_DESCRIPTION = _('Quick notes from ~/config/widgets@kin/notes.txt.');
