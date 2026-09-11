# Marimo Notebooks

> **Unofficial.** This is a community-built integration and is not
> affiliated with, endorsed by, or supported by the
> [marimo](https://github.com/marimo-team/marimo) project.

Edit and run marimo reactive Python notebooks from inside your Obsidian vault.

marimo notebooks are plain `.py` files. Obsidian normally only opens `.md`
files and hides everything else, so this plugin registers the `.py` extension:
Python notebooks appear in the file explorer and clicking one opens it in a
pane backed by a local marimo server. Each notebook can be shown two ways:

- **Editor** (`marimo edit`) — the full reactive notebook editor.
- **App** (`marimo run`) — the notebook served as an app, the way a published
  marimo notebook looks on the web: outputs and widgets only, no code.

## Requirements

- Python 3, with the [`marimo`](https://pypi.org/project/marimo/) package
  installed (`pip install marimo`). The plugin can install it for you the
  first time you create a notebook if it's missing.
- Desktop only — this plugin spawns a local process, which isn't supported on
  mobile.

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/kammmran/marimo4obs/releases).
2. Copy them into `<your vault>/.obsidian/plugins/marimo-notebooks/`.
3. Reload Obsidian and enable "Marimo Notebooks" under Settings → Community plugins.

### From source

```bash
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` into your vault's
`.obsidian/plugins/marimo-notebooks/` folder as above.

## Usage

- Click the play-circle icon in the ribbon (or run the **New marimo
  notebook** command) to create a new notebook. Give it a name and the
  plugin creates a `.py` file with a minimal marimo notebook template, then
  opens it.
- Click any `.py` file in the file explorer to open it in marimo, or
  right-click it and choose **Open in marimo editor** / **Open as marimo
  app**. The same two actions are available as commands for the active file,
  and **Toggle between marimo editor and app** switches an open pane.
- The pane toolbar starts with an **Edit** / **App** switch, followed by
  **Reload**, **Restart server**, and **Open in browser**.
- Each open notebook runs its own local marimo server, bound to `127.0.0.1`
  on a free port chosen by the plugin, and embedded in the pane. Editor and
  app mode use separate servers. A server is stopped when its last pane
  closes (configurable), and a notebook reopened from a restored workspace
  starts a fresh server automatically.

## Settings

- **marimo executable path** — leave empty to auto-detect. Set a full path
  (e.g. `/path/to/venv/bin/marimo`) to pin a specific virtualenv.
- **Python executable path** — leave empty to auto-detect. Used to run marimo
  as a module (`python -m marimo`) and to install it.
- **Default view** — whether notebooks open in the editor or as an app.
- **Show code in the app view** — passes `--include-code` to `marimo run` so
  readers can expand the Python behind each cell.
- **Open .py files in the vault** — registers the `.py` extension so Python
  files show up in the file explorer and open in marimo. Turn it off if
  another plugin handles `.py`; the commands keep working either way.
  Changing it takes effect after a reload.
- **Reload on external edits** — passes `--watch` so marimo reloads changes
  made in Obsidian's own editor. Off by default, because marimo warns it can
  interfere with its auto-save.
- **Keep servers running when a pane closes** — reopening is then instant, at
  the cost of leaving the Python process alive.
- **Startup timeout** — how long to wait for the server to become ready.
- **Extra CLI arguments** — extra flags passed to `marimo edit` / `marimo run`.

## Troubleshooting

If a notebook won't open, run the **Diagnose marimo setup** command (or the
*Run diagnostics* button in settings). It shows which `marimo` and Python
executables the plugin resolved and the full `PATH` it searched.

The most common cause is that a desktop-launched Obsidian doesn't inherit
your shell's `PATH`, so a `marimo` installed by Homebrew, `pip --user`, pyenv
or a virtualenv is invisible to it. The plugin works around this by reading
your login shell's `PATH` at startup and also searching the usual install
directories; if your setup is unusual, set a full executable path in settings.

## Security notes

This plugin launches local processes (`child_process`) to run the `marimo`
CLI and, when you approve it, `python -m pip install marimo`. Commands are
spawned directly with an argument list rather than through a shell, so vault
paths are never interpreted as shell syntax. Servers bind to `127.0.0.1`
only. Nothing is sent over the network beyond what the marimo/Python
processes do on your own machine. Executable paths are auto-detected and can
be pinned in plugin settings.

To find `marimo` when Obsidian is launched from the desktop, the plugin reads
your login shell's `PATH` once at startup (`$SHELL -ilc`), which runs your
shell's startup files.

## License

[MIT](LICENSE)
