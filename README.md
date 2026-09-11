# Marimo Notebooks

> **Unofficial.** This is a community-built integration and is not
> affiliated with, endorsed by, or supported by the
> [marimo](https://github.com/marimo-team/marimo) project.

Edit and run marimo reactive Python notebooks from inside your Obsidian vault.

marimo notebooks are plain `.py` files. This plugin launches a local marimo
server for the notebook you open and embeds its editor directly in a pane, so
you can create, edit, and run Python notebooks alongside the rest of your
notes.

## Requirements

- Python 3, with the [`marimo`](https://pypi.org/project/marimo/) package
  installed (`pip install marimo`). The plugin can install it for you the
  first time you create a notebook if it's missing.
- Desktop only — this plugin spawns a local process, which isn't supported on
  mobile.

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/kammmran/marimo-for-obsidian/releases).
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
- To open an existing marimo notebook, right-click a `.py` file and choose
  **Open in marimo**, or run **Open current notebook in marimo** while it's
  the active file.
- Each open notebook runs its own local marimo server (`marimo edit`), bound
  to `127.0.0.1` on a free port chosen by the plugin, and embedded in the
  pane. The server is stopped when you close its pane (configurable).
- The pane toolbar has **Reload**, **Restart server**, and **Open in
  browser**. Reopening a notebook from a restored workspace starts a fresh
  server automatically.

## Settings

- **marimo executable path** — leave empty to auto-detect. Set a full path
  (e.g. `/path/to/venv/bin/marimo`) to pin a specific virtualenv.
- **Python executable path** — leave empty to auto-detect. Used to run marimo
  as a module (`python -m marimo`) and to install it.
- **Reload on external edits** — passes `--watch` so marimo reloads changes
  made in Obsidian's own editor. Off by default, because marimo warns it can
  interfere with its auto-save.
- **Keep servers running when a pane closes** — reopening is then instant, at
  the cost of leaving the Python process alive.
- **Startup timeout** — how long to wait for the server to become ready.
- **Extra CLI arguments** — extra flags passed to `marimo edit`.

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
