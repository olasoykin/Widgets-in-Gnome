# Widgets for GNOME

![Widgets displayed on a GNOME desktop](image.png)

Widgets is a GNOME Shell extension for placing customizable widgets on the desktop. It brings useful information and tools into view, with a look that can blend into the desktop using blur effects.

The extension declares compatibility with GNOME Shell 50 and 51.

## Weather and notes

Weather preferences let you choose a city, temperature units, and how often the forecast refreshes. If a custom city is disabled, the widget estimates a nearby location from your network address.

The Notes widget reads `~/.config/widgets@kin/notes.txt`. Separate notes with a line containing `---`; start a note with `# Title` to give it a heading. It supports simple bold (`**text**`), italic (`*text*`), bullet (`- text`), and checklist (`- [ ]` / `- [x]`) formatting. For example:

```text
# Shopping
- [ ] Coffee
- [ ] Fruit

---

# Reminder
Call **Ana** on Friday.
```

## Dependencies

Install these GNOME extensions before enabling Widgets:

- **Blur my Shell**: provides the blur effects.
- **Add to Desktop**: allows items to be displayed on the desktop.

You can install them using the **Extension Manager** app or from [extensions.gnome.org](https://extensions.gnome.org/). These dependencies are installed separately and are not included in this project.

## Installation

1. Install and enable **Blur my Shell** and **Add to Desktop**.
2. Paste this command into a terminal to download, install, and enable Widgets:

   ```sh
   mkdir -p ~/.local/share/gnome-shell/extensions && \
   git clone --depth=1 https://github.com/olasoykin/Widgets-in-Gnome.git ~/.local/share/gnome-shell/extensions/widgets@kin 
   gnome-extensions enable widgets@kin
   ```

If the extension does not appear or activate, log out and back in. On GNOME running on Xorg, you can also restart GNOME Shell by pressing `Alt` + `F2`, entering `r`, and pressing `Enter`.

## License

Copyright (C) 2026 olasoykin

This project is licensed under the GNU General Public License, version 3 or (at your option) any later version. See [LICENSE](LICENSE) for the full text.
