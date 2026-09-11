import {
	App,
	FileSystemAdapter,
	ItemView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from "child_process";

const VIEW_TYPE_MARIMO = "marimo4obs-view";

interface marimoSettings {
	marimoPath: string;
	pythonPath: string;
	extraArgs: string;
}

const DEFAULT_SETTINGS: marimoSettings = {
	marimoPath: "marimo",
	pythonPath: "python3",
	extraArgs: "",
};

const NEW_NOTEBOOK_TEMPLATE = `import marimo

__generated_with = "0.9.14"
app = marimo.App()


@app.cell
def __():
    import marimo as mo
    return (mo,)


@app.cell
def __(mo):
    mo.md("# New notebook")
    return


if __name__ == "__main__":
    app.run()
`;

interface RunningServer {
	process: ChildProcessWithoutNullStreams;
	url: string;
	filePath: string;
}

export default class marimoPlugin extends Plugin {
	settings!: marimoSettings;
	servers: Map<string, RunningServer> = new Map();

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_MARIMO,
			(leaf) => new MarimoView(leaf, this)
		);

		this.addCommand({
			id: "open-in-marimo",
			name: "Open current notebook in marimo",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const isPy = !!file && file.extension === "py";
				if (checking) return isPy;
				if (file) this.openMarimoNotebook(file);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile && file.extension === "py") {
					menu.addItem((item) => {
						item.setTitle("Open in marimo")
							.setIcon("play-circle")
							.onClick(() => this.openMarimoNotebook(file));
					});
				}
			})
		);

		this.addRibbonIcon("play-circle", "New marimo notebook", () => {
			new NewNotebookModal(this.app, (name) => this.createNewNotebook(name)).open();
		});

		this.addCommand({
			id: "new-marimo-notebook",
			name: "New marimo notebook",
			callback: () => {
				new NewNotebookModal(this.app, (name) => this.createNewNotebook(name)).open();
			},
		});

		this.addSettingTab(new marimoSettingTab(this.app, this));
	}

	onunload() {
		for (const server of this.servers.values()) {
			server.process.kill();
		}
		this.servers.clear();
	}

	getVaultBasePath(): string {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}
		throw new Error("marimo requires a local vault (desktop only).");
	}

	async createNewNotebook(rawName: string) {
		const name = rawName.trim() || "Untitled";
		const fileName = name.endsWith(".py") ? name : `${name}.py`;

		const existing = this.app.vault.getAbstractFileByPath(fileName);
		if (existing) {
			new Notice(`"${fileName}" already exists.`);
			return;
		}

		const ready = await this.ensurePythonAndMarimo();
		if (!ready) return;

		const file = await this.app.vault.create(fileName, NEW_NOTEBOOK_TEMPLATE);
		new Notice(`Created ${fileName}`);
		await this.openMarimoNotebook(file);
	}

	/** Checks that python + the marimo package are available, offering to `pip install marimo` if not. */
	private async ensurePythonAndMarimo(): Promise<boolean> {
		const python = spawnSync(this.settings.pythonPath, ["--version"], {
			shell: true,
		});
		if (python.error || python.status !== 0) {
			new Notice(
				`Python not found at "${this.settings.pythonPath}". Install Python from python.org, then set the path in marimo settings.`,
				10000
			);
			return false;
		}

		const marimoCheck = spawnSync(
			this.settings.pythonPath,
			["-c", "import marimo"],
			{ shell: true }
		);
		if (marimoCheck.status === 0) return true;

		const shouldInstall = await new Promise<boolean>((resolve) => {
			new ConfirmModal(
				this.app,
				"Install marimo?",
				"The marimo Python package isn't installed. Install it now with pip?",
				resolve
			).open();
		});
		if (!shouldInstall) return false;

		return this.installMarimo();
	}

	private installMarimo(): Promise<boolean> {
		const notice = new Notice("Installing marimo...", 0);
		return new Promise((resolve) => {
			const proc = spawn(
				this.settings.pythonPath,
				["-m", "pip", "install", "--upgrade", "marimo"],
				{ shell: true }
			);

			let output = "";
			proc.stdout.on("data", (chunk) => (output += chunk.toString()));
			proc.stderr.on("data", (chunk) => (output += chunk.toString()));

			proc.on("error", (err) => {
				notice.hide();
				new Notice(`Failed to run pip: ${err.message}`);
				resolve(false);
			});

			proc.on("exit", (code) => {
				notice.hide();
				if (code === 0) {
					new Notice("marimo installed successfully.");
					resolve(true);
				} else {
					console.error(output);
					new Notice(
						`pip install marimo failed (code ${code}). See console for details.`,
						10000
					);
					resolve(false);
				}
			});
		});
	}

	async openMarimoNotebook(file: TFile) {
		let server = this.servers.get(file.path);
		if (!server) {
			try {
				server = await this.startServer(file);
			} catch (e) {
				console.error(e);
				const message = e instanceof Error ? e.message : String(e);
				new Notice(`Failed to start marimo: ${message}`);
				return;
			}
		}

		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_MARIMO,
			active: true,
			state: { filePath: file.path, url: server.url },
		});
		this.app.workspace.revealLeaf(leaf);
	}

	private startServer(file: TFile): Promise<RunningServer> {
		const basePath = this.getVaultBasePath();
		const absolutePath = `${basePath}/${file.path}`;
		const args = [
			"edit",
			absolutePath,
			"--headless",
			"--no-token",
			"--port",
			"0",
			...this.settings.extraArgs.split(" ").filter(Boolean),
		];

		return new Promise((resolve, reject) => {
			const proc = spawn(this.settings.marimoPath, args, {
				shell: true,
			});

			let resolved = false;
			const urlRegex = /https?:\/\/[^\s]+/;
			let buffer = "";

			const onData = (chunk: Buffer) => {
				buffer += chunk.toString();
				const match = buffer.match(urlRegex);
				if (match && !resolved) {
					resolved = true;
					const server: RunningServer = {
						process: proc,
						url: match[0],
						filePath: file.path,
					};
					this.servers.set(file.path, server);
					resolve(server);
				}
			};

			proc.stdout.on("data", onData);
			proc.stderr.on("data", onData);

			proc.on("error", (err) => {
				if (!resolved) reject(err);
			});

			proc.on("exit", (code) => {
				this.servers.delete(file.path);
				if (!resolved) {
					reject(
						new Error(
							`marimo exited before starting (code ${code}). Is '${this.settings.marimoPath}' on PATH?`
						)
					);
				}
			});

			setTimeout(() => {
				if (!resolved) {
					proc.kill();
					reject(new Error("Timed out waiting for marimo to start."));
				}
			}, 15000);
		});
	}

	stopServer(filePath: string) {
		const server = this.servers.get(filePath);
		if (server) {
			server.process.kill();
			this.servers.delete(filePath);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class MarimoView extends ItemView {
	plugin: marimoPlugin;
	filePath!: string;
	url!: string;
	iframe!: HTMLIFrameElement;

	constructor(leaf: WorkspaceLeaf, plugin: marimoPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_MARIMO;
	}

	getDisplayText() {
		return this.filePath ? `marimo: ${this.filePath}` : "marimo";
	}

	getIcon() {
		return "play-circle";
	}

	async setState(state: { filePath: string; url: string }) {
		this.filePath = state.filePath;
		this.url = state.url;
		this.render();
	}

	getState() {
		return { filePath: this.filePath, url: this.url };
	}

	render() {
		const container = this.contentEl;
		container.empty();
		container.addClass("marimo4obs-view-container");

		this.iframe = container.createEl("iframe", {
			attr: {
				src: this.url,
				sandbox:
					"allow-scripts allow-same-origin allow-forms allow-popups allow-modals",
			},
		});
		this.iframe.style.width = "100%";
		this.iframe.style.height = "100%";
		this.iframe.style.border = "none";
	}

	async onClose() {
		if (this.filePath) {
			this.plugin.stopServer(this.filePath);
		}
	}
}

class NewNotebookModal extends Modal {
	private onSubmit: (name: string) => void;

	constructor(app: App, onSubmit: (name: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "New marimo notebook" });

		let value = "Untitled";
		const setting = new Setting(contentEl).setName("File name");
		setting.addText((text) => {
			text.setValue(value).onChange((v) => (value = v));
			text.inputEl.focus();
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					this.close();
					this.onSubmit(value);
				}
			});
		});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Create")
				.setCta()
				.onClick(() => {
					this.close();
					this.onSubmit(value);
				})
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class ConfirmModal extends Modal {
	private title: string;
	private message: string;
	private onResult: (confirmed: boolean) => void;

	constructor(app: App, title: string, message: string, onResult: (confirmed: boolean) => void) {
		super(app);
		this.title = title;
		this.message = message;
		this.onResult = onResult;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.message });

		const buttons = new Setting(contentEl);
		buttons.addButton((btn) =>
			btn
				.setButtonText("Cancel")
				.onClick(() => {
					this.close();
					this.onResult(false);
				})
		);
		buttons.addButton((btn) =>
			btn
				.setButtonText("Install")
				.setCta()
				.onClick(() => {
					this.close();
					this.onResult(true);
				})
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class marimoSettingTab extends PluginSettingTab {
	plugin: marimoPlugin;

	constructor(app: App, plugin: marimoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			text: "Marimo4Obs is an unofficial, community-built integration and is not affiliated with or endorsed by the marimo project.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("marimo executable path")
			.setDesc(
				"Path to the marimo CLI. Use just 'marimo' if it's on your PATH, or a full path (e.g. from a virtualenv)."
			)
			.addText((text) =>
				text
					.setPlaceholder("marimo")
					.setValue(this.plugin.settings.marimoPath)
					.onChange(async (value) => {
						this.plugin.settings.marimoPath = value.trim() || "marimo";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Python executable path")
			.setDesc(
				"Path to python3, used to check for/install the marimo package. Use a full path to target a specific virtualenv."
			)
			.addText((text) =>
				text
					.setPlaceholder("python3")
					.setValue(this.plugin.settings.pythonPath)
					.onChange(async (value) => {
						this.plugin.settings.pythonPath = value.trim() || "python3";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Extra CLI arguments")
			.setDesc("Space-separated extra flags passed to 'marimo edit'.")
			.addText((text) =>
				text
					.setPlaceholder("")
					.setValue(this.plugin.settings.extraArgs)
					.onChange(async (value) => {
						this.plugin.settings.extraArgs = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
