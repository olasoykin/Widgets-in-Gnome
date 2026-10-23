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

function _escapeMarkup(text) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function _formatNoteMarkup(text) {
    return text.split('\n').map(line => {
        let markup = _escapeMarkup(line);
        markup = markup.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
        markup = markup.replace(/\*([^*]+)\*/g, '<i>$1</i>');
        markup = markup.replace(/^- \[x\] /i, '☑ ');
        markup = markup.replace(/^- \[ \] /, '☐ ');
        markup = markup.replace(/^[-*] /, '• ');
        return markup;
    }).join('\n');
}

function _parseNotes(text) {
    return text.split(/^\s*---\s*$/m)
        .map(section => section.trim())
        .filter(Boolean)
        .map(section => {
            const lines = section.split('\n');
            let title = '';
            if (/^#{1,2}\s+/.test(lines[0])) title = lines.shift().replace(/^#{1,2}\s+/, '').trim();
            return { title, body: lines.join('\n').trim() };
        })
        .filter(note => note.title || note.body);
}

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
        this._monitorChangedId = 0;
        this._loadNotes();
        this._watchNotesFile();

        this.connect('destroy', () => {
            if (this._monitor) {
                if (this._monitorChangedId) {
                    this._monitor.disconnect(this._monitorChangedId);
                    this._monitorChangedId = 0;
                }
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

        this._notesScroll = new St.ScrollView({
            style_class: 'widget-notes-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        this._notesScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._notesList = new St.BoxLayout({
            style_class: 'widget-notes-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: false,
            x_align: Clutter.ActorAlign.FILL,
        });
        this._notesScroll.set_child(this._notesList);

        contentBox.add_child(header);
        contentBox.add_child(this._notesScroll);
        card.add_child(contentBox);
        this.setCard(card);
    }

    _createNoteLabel(text, styleClass, markup = false) {
        const params = {
            style_class: styleClass,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        };
        if (!markup) params.text = text;
        const label = new St.Label(params);
        const clutterText = label.get_clutter_text();
        clutterText.line_wrap = true;
        clutterText.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        clutterText.ellipsize = Pango.EllipsizeMode.NONE;
        if (markup) clutterText.set_markup(_formatNoteMarkup(text));
        return label;
    }

    _renderNotes(text) {
        this._notesList.destroy_all_children();
        const notes = _parseNotes(text);
        if (notes.length === 0) {
            const emptyLabel = this._createNoteLabel(EMPTY_HINT, 'widget-notes-text widget-notes-empty');
            this._notesList.add_child(emptyLabel);
            return;
        }

        for (const note of notes) {
            const noteBox = new St.BoxLayout({
                style_class: 'widget-note-item',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            if (note.title) {
                noteBox.add_child(this._createNoteLabel(note.title, 'widget-notes-title'));
            }
            if (note.body) {
                noteBox.add_child(this._createNoteLabel(note.body, 'widget-notes-text', true));
            }
            this._notesList.add_child(noteBox);
        }
    }

    _loadNotes() {
        try {
            const file = Gio.File.new_for_path(this._notesPath);
            if (!file.query_exists(null)) {
                GLib.mkdir_with_parents(GLib.path_get_dirname(this._notesPath), 0o700);
                file.replace_contents('', null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                this._renderNotes('');
                return;
            }

            const [, contents] = file.load_contents(null);
            this._renderNotes(new TextDecoder().decode(contents).trim());
        } catch (error) {
            this._renderNotes(_('Could not read the notes file'));
            console.warn(`[Widgets] Notes: ${error.message}`);
        }
    }

    _watchNotesFile() {
        try {
            const file = Gio.File.new_for_path(this._notesPath);
            this._monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitorChangedId = this._monitor.connect('changed', () => this._loadNotes());
        } catch (error) {
            console.warn(`[Widgets] Could not monitor notes: ${error.message}`);
        }
    }
});

export const WIDGET_CONFIG = { colSpan: 2, rowSpan: 3 };
export const WIDGET_NAME = _('Notes');
export const WIDGET_DESCRIPTION = _('Quick notes from ~/config/widgets@kin/notes.txt.');
