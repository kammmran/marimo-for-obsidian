# marimo for Obsidian

Edit and run [marimo](https://github.com/marimo-team/marimo) reactive Python notebooks from inside your vault.

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
2. Copy them into `<your vault>/.obsidian/plugins/marimo/`.
3. Reload Obsidian and enable "marimo" under Settings → Community plugins.

### From source

```bash
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` into your vault's
`.obsidian/plugins/marimo/` folder as above.

## Usage

- Click the play-circle icon in the ribbon (or run the **New marimo
  notebook** command) to create a new notebook. Give it a name and the
  plugin creates a `.py` file with a minimal marimo notebook template, then
  opens it.
- To open an existing marimo notebook, right-click a `.py` file and choose
  **Open in marimo**, or run **Open current notebook in marimo** while it's
  the active file.
- Each open notebook runs its own local marimo server (`marimo edit`). The
  server for a notebook is stopped when you close its pane.

## Settings

- **marimo executable path** — defaults to `marimo`. Set a full path if it's
  not on your `PATH` (e.g. inside a virtualenv).
- **Python executable path** — defaults to `python3`. Used to check for and
  install the `marimo` package.
- **Extra CLI arguments** — extra flags passed to `marimo edit`.

## License

[MIT](LICENSE)
