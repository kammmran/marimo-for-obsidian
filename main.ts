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
import { ChildProcess, execFile, spawn, spawnSync } from "child_process";
import { createServer } from "net";
import { existsSync } from "fs";
import { delimiter, join } from "path";
import { homedir } from "os";

const VIEW_TYPE_MARIMO = "marimo4obs-view";

interface marimoSettings {
	marimoPath: string;
	pythonPath: string;
	extraArgs: string;
	watchFile: boolean;
	keepServersAlive: boolean;
	startupTimeoutSeconds: number;
}

const DEFAULT_SETTINGS: marimoSettings = {
	marimoPath: "",
	pythonPath: "",
	extraArgs: "",
	watchFile: false,
	keepServersAlive: false,
	startupTimeoutSeconds: 60,
};

const NEW_NOTEBOOK_TEMPLATE = `import marimo

app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    return (mo,)


@app.cell
def _(mo):
    mo.md("# New notebook")
    return


if __name__ == "__main__":
    app.run()
`;

/**
 * Launcher describing how to invoke marimo: either the CLI binary directly, or
 * a Python interpreter with `-m marimo`.
 */
interface Launcher {
	command: string;
	baseArgs: string[];
	label: string;
}

interface RunningServer {
	process: ChildProcess;
	url: string;
	filePath: string;
	port: number;
}

/**
 * GUI apps on macOS/Linux are launched by the window manager, not a login
 * shell, so they inherit a bare PATH that usually excludes Homebrew,
 * ~/.local/bin and virtualenvs. That is the most common reason marimo appears
 * "not installed" inside Obsidian even though it runs fine in a terminal.
 */
function commonBinDirs(): string[] {
	const home = homedir();
	const dirs = [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		join(home, ".local", "bin"),
		join(home, "bin"),
		join(home, ".pyenv", "shims"),
		join(home, ".rye", "shims"),
		join(home, ".cargo", "bin"),
		"/opt/local/bin",
	];
	if (process.platform === "win32") {
		const appData = process.env.LOCALAPPDATA;
		if (appData) dirs.push(join(appData, "Programs", "Python"));
	}
	return dirs;
}

/** Asks the user's login shell for its PATH, so pyenv/conda/rc-file setup is honoured. */
function loginShellPath(): Promise<string | null> {
	if (process.platform === "win32") return Promise.resolve(null);
	const shell = process.env.SHELL || "/bin/zsh";
	return new Promise((resolve) => {
		execFile(
			shell,
			["-ilc", "command -p echo __M4O__$PATH"],
			{ timeout: 5000, env: { ...process.env } },
			(err, stdout) => {
				if (err && !stdout) return resolve(null);
				const match = /__M4O__(.*)/.exec(stdout || "");
				resolve(match ? match[1].trim() : null);
			}
		);
	});
}

export default class marimoPlugin extends Plugin {
	settings!: marimoSettings;
	servers: Map<string, RunningServer> = new Map();
	/** PATH used for every spawned process; widened on load. */
	private searchPath: string = process.env.PATH || "";
	private launcher: Launcher | null = null;
	private startupLog: Map<string, string> = new Map();

	async onload() {
		await this.loadSettings();
		void this.refreshSearchPath();

		this.registerView(VIEW_TYPE_MARIMO, (leaf) => new MarimoView(leaf, this));

		this.addCommand({
			id: "open-in-marimo",
			name: "Open current notebook in marimo",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const isPy = !!file && file.extension === "py";
				if (checking) return isPy;
				if (file) void this.openMarimoNotebook(file);
				return true;
			},
		});

		this.addCommand({
			id: "new-marimo-notebook",
			name: "New marimo notebook",
			callback: () => {
				new NewNotebookModal(this.app, (name) => void this.createNewNotebook(name)).open();
			},
		});

		this.addCommand({
			id: "diagnose-marimo",
			name: "Diagnose marimo setup",
			callback: () => void this.showDiagnostics(),
		});

		this.addCommand({
			id: "stop-marimo-servers",
			name: "Stop all marimo servers",
			callback: () => {
				const count = this.servers.size;
				this.stopAllServers();
				new Notice(count ? `Stopped ${count} marimo server(s).` : "No marimo servers running.");
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFile && file.extension === "py") {
					menu.addItem((item) => {
						item.setTitle("Open in marimo")
							.setIcon("play-circle")
							.onClick(() => void this.openMarimoNotebook(file));
					});
				}
			})
		);

		this.addRibbonIcon("play-circle", "New marimo notebook", () => {
			new NewNotebookModal(this.app, (name) => void this.createNewNotebook(name)).open();
		});

		this.addSettingTab(new marimoSettingTab(this.app, this));
	}

	onunload() {
		this.stopAllServers();
	}

	stopAllServers() {
		for (const server of this.servers.values()) {
			this.killProcess(server.process);
		}
		this.servers.clear();
	}

	private killProcess(proc: ChildProcess) {
		try {
			proc.kill();
			// marimo can take a moment to tear down its uvicorn loop.
			const pid = proc.pid;
			window.setTimeout(() => {
				if (pid && !proc.killed) {
					try {
						proc.kill("SIGKILL");
					} catch {
						/* already gone */
					}
				}
			}, 3000);
		} catch {
			/* already gone */
		}
	}

	/** Widens PATH with the login shell's PATH plus well-known install dirs. */
	async refreshSearchPath() {
		const parts: string[] = [];
		const push = (value: string | null | undefined) => {
			if (!value) return;
			for (const dir of value.split(delimiter)) {
				if (dir && !parts.includes(dir)) parts.push(dir);
			}
		};
		push(process.env.PATH);
		push(await loginShellPath());
		for (const dir of commonBinDirs()) push(dir);
		this.searchPath = parts.join(delimiter);
		this.launcher = null;
	}

	private spawnEnv(): NodeJS.ProcessEnv {
		return {
			...process.env,
			PATH: this.searchPath,
			// Keep marimo's own output parseable and unbuffered.
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
			FORCE_COLOR: "0",
			NO_COLOR: "1",
			TERM: "dumb",
		};
	}

	/** True when `candidate` runs and exits cleanly with the given probe args. */
	private probe(command: string, args: string[]): boolean {
		try {
			const result = spawnSync(command, args, {
				env: this.spawnEnv(),
				timeout: 15000,
				windowsHide: true,
			});
			return !result.error && result.status === 0;
		} catch {
			return false;
		}
	}

	private resolveOnPath(name: string): string | null {
		if (name.includes("/") || name.includes("\\")) {
			return existsSync(name) ? name : null;
		}
		const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
		for (const dir of this.searchPath.split(delimiter)) {
			if (!dir) continue;
			for (const ext of exts) {
				const candidate = join(dir, name + ext);
				if (existsSync(candidate)) return candidate;
			}
		}
		return null;
	}

	/**
	 * Finds a working way to run marimo. Prefers an explicit setting, then the
	 * marimo CLI on PATH, then `<python> -m marimo` (which covers virtualenvs
	 * where only the interpreter path is known).
	 */
	resolveLauncher(force = false): Launcher | null {
		if (this.launcher && !force) return this.launcher;

		const configuredMarimo = this.settings.marimoPath.trim();
		const configuredPython = this.settings.pythonPath.trim();

		const marimoCandidates = configuredMarimo
			? [configuredMarimo]
			: ["marimo"];
		for (const name of marimoCandidates) {
			const resolved = this.resolveOnPath(name);
			if (resolved && this.probe(resolved, ["--version"])) {
				this.launcher = { command: resolved, baseArgs: [], label: resolved };
				return this.launcher;
			}
		}

		const pythonCandidates = configuredPython
			? [configuredPython]
			: ["python3", "python"];
		for (const name of pythonCandidates) {
			const resolved = this.resolveOnPath(name);
			if (!resolved) continue;
			// A python that can import marimo can always run `-m marimo`.
			if (this.probe(resolved, ["-c", "import marimo"])) {
				this.launcher = {
					command: resolved,
					baseArgs: ["-m", "marimo"],
					label: `${resolved} -m marimo`,
				};
				return this.launcher;
			}
			// Sibling binary inside the same venv/bin directory.
			const sibling = join(resolved, "..", process.platform === "win32" ? "marimo.exe" : "marimo");
			if (existsSync(sibling) && this.probe(sibling, ["--version"])) {
				this.launcher = { command: sibling, baseArgs: [], label: sibling };
				return this.launcher;
			}
		}

		this.launcher = null;
		return null;
	}

	private findPython(): string | null {
		const configured = this.settings.pythonPath.trim();
		for (const name of configured ? [configured] : ["python3", "python"]) {
			const resolved = this.resolveOnPath(name);
			if (resolved && this.probe(resolved, ["--version"])) return resolved;
		}
		return null;
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

		if (this.app.vault.getAbstractFileByPath(fileName)) {
			new Notice(`"${fileName}" already exists.`);
			return;
		}

		if (!(await this.ensureMarimoAvailable())) return;

		const file = await this.app.vault.create(fileName, NEW_NOTEBOOK_TEMPLATE);
		new Notice(`Created ${fileName}`);
		await this.openMarimoNotebook(file);
	}

	/** Ensures marimo is runnable, offering to pip install it when it isn't. */
	async ensureMarimoAvailable(): Promise<boolean> {
		if (this.resolveLauncher(true)) return true;

		// Maybe PATH was captured before the user's shell was ready.
		await this.refreshSearchPath();
		if (this.resolveLauncher(true)) return true;

		const python = this.findPython();
		if (!python) {
			new Notice(
				"Couldn't find Python. Install Python 3, then set its full path in Marimo4Obs settings (run \"Diagnose marimo setup\" for details).",
				12000
			);
			return false;
		}

		const shouldInstall = await new Promise<boolean>((resolve) => {
			new ConfirmModal(
				this.app,
				"Install marimo?",
				`The marimo package isn't available to ${python}. Install it now with pip?`,
				"Install",
				resolve
			).open();
		});
		if (!shouldInstall) return false;

		const ok = await this.installMarimo(python);
		if (!ok) return false;
		return this.resolveLauncher(true) !== null;
	}

	private installMarimo(python: string): Promise<boolean> {
		const notice = new Notice("Installing marimo...", 0);
		return new Promise<boolean>((resolve) => {
			const proc = spawn(python, ["-m", "pip", "install", "--upgrade", "marimo"], {
				env: this.spawnEnv(),
				windowsHide: true,
			});

			let output = "";
			proc.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
			proc.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

			proc.on("error", (err: Error) => {
				notice.hide();
				new Notice(`Failed to run pip: ${err.message}`, 10000);
				resolve(false);
			});

			proc.on("exit", (code: number | null) => {
				notice.hide();
				if (code === 0) {
					new Notice("marimo installed successfully.");
					resolve(true);
				} else {
					console.error("[Marimo4Obs] pip install failed:\n" + output);
					new ErrorModal(
						this.app,
						"Installing marimo failed",
						`pip exited with code ${code}.`,
						output
					).open();
					resolve(false);
				}
			});
		});
	}

	async openMarimoNotebook(file: TFile) {
		let server = this.servers.get(file.path);
		if (!server) {
			if (!(await this.ensureMarimoAvailable())) return;
			const notice = new Notice(`Starting marimo for ${file.name}...`, 0);
			try {
				server = await this.startServer(file);
			} catch (e) {
				notice.hide();
				const message = e instanceof Error ? e.message : String(e);
				const log = this.startupLog.get(file.path) || "";
				console.error("[Marimo4Obs] " + message + "\n" + log);
				new ErrorModal(this.app, "Couldn't start marimo", message, log).open();
				return;
			}
			notice.hide();
		}

		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_MARIMO,
			active: true,
			state: { filePath: file.path, url: server.url },
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	/** Reserves a free TCP port by briefly binding one. */
	private freePort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const srv = createServer();
			srv.unref();
			srv.on("error", reject);
			srv.listen(0, "127.0.0.1", () => {
				const address = srv.address();
				const port = typeof address === "object" && address ? address.port : 0;
				srv.close(() => (port ? resolve(port) : reject(new Error("No free port available."))));
			});
		});
	}

	private async waitForHealthy(port: number, deadline: number, proc: ChildProcess) {
		const url = `http://127.0.0.1:${port}/health`;
		for (;;) {
			if (proc.exitCode !== null || proc.signalCode !== null) {
				throw new Error(`marimo exited before it finished starting (code ${proc.exitCode}).`);
			}
			if (Date.now() > deadline) {
				throw new Error(
					`marimo didn't become ready within ${this.settings.startupTimeoutSeconds}s.`
				);
			}
			try {
				const res = await fetch(url, { method: "GET" });
				if (res.ok) return;
			} catch {
				/* not listening yet */
			}
			await new Promise((r) => window.setTimeout(r, 300));
		}
	}

	private async startServer(file: TFile): Promise<RunningServer> {
		const launcher = this.resolveLauncher();
		if (!launcher) throw new Error("marimo isn't available. Run \"Diagnose marimo setup\".");

		const basePath = this.getVaultBasePath();
		const absolutePath = join(basePath, file.path);
		const port = await this.freePort();

		const args = [
			...launcher.baseArgs,
			"edit",
			absolutePath,
			"--headless",
			"--no-token",
			"--skip-update-check",
			"--host",
			"127.0.0.1",
			"-p",
			String(port),
			...(this.settings.watchFile ? ["--watch"] : []),
			...this.settings.extraArgs.split(/\s+/).filter(Boolean),
		];

		// No `shell: true`: arguments are passed verbatim, so vault paths
		// containing spaces or quotes work correctly.
		const proc = spawn(launcher.command, args, {
			cwd: basePath,
			env: this.spawnEnv(),
			windowsHide: true,
		});

		let log = "";
		const record = (chunk: Buffer) => {
			log += chunk.toString();
			if (log.length > 20000) log = log.slice(-20000);
			this.startupLog.set(file.path, log);
		};
		proc.stdout?.on("data", record);
		proc.stderr?.on("data", record);

		const spawnFailure = new Promise<never>((_, reject) => {
			proc.once("error", (err: Error) =>
				reject(
					new Error(
						`Couldn't launch "${launcher.command}": ${err.message}`
					)
				)
			);
		});

		proc.on("exit", () => {
			this.servers.delete(file.path);
		});

		const deadline = Date.now() + Math.max(10, this.settings.startupTimeoutSeconds) * 1000;
		try {
			await Promise.race([this.waitForHealthy(port, deadline, proc), spawnFailure]);
		} catch (e) {
			this.killProcess(proc);
			const detail = log.trim();
			const hint = /command not found|No such file|not recognized/i.test(detail)
				? ` Marimo4Obs used "${launcher.label}".`
				: "";
			throw new Error((e instanceof Error ? e.message : String(e)) + hint);
		}

		const server: RunningServer = {
			process: proc,
			url: `http://127.0.0.1:${port}`,
			filePath: file.path,
			port,
		};
		this.servers.set(file.path, server);
		this.startupLog.delete(file.path);
		return server;
	}

	getServer(filePath: string): RunningServer | undefined {
		return this.servers.get(filePath);
	}

	/** Called when a marimo pane closes. */
	releaseServer(filePath: string) {
		if (this.settings.keepServersAlive) return;
		// Another pane may still be showing the same notebook.
		const stillOpen = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_MARIMO)
			.some((leaf) => (leaf.view as MarimoView).filePath === filePath);
		if (stillOpen) return;
		this.stopServer(filePath);
	}

	stopServer(filePath: string) {
		const server = this.servers.get(filePath);
		if (server) {
			this.killProcess(server.process);
			this.servers.delete(filePath);
		}
	}

	async restartServer(filePath: string): Promise<RunningServer | null> {
		this.stopServer(filePath);
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			new Notice(`${filePath} no longer exists.`);
			return null;
		}
		try {
			return await this.startServer(file);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			new ErrorModal(
				this.app,
				"Couldn't restart marimo",
				message,
				this.startupLog.get(filePath) || ""
			).open();
			return null;
		}
	}

	async showDiagnostics() {
		await this.refreshSearchPath();
		const launcher = this.resolveLauncher(true);
		const python = this.findPython();
		const lines = [
			`Platform: ${process.platform}`,
			`marimo launcher: ${launcher ? launcher.label : "NOT FOUND"}`,
			`Python: ${python ?? "NOT FOUND"}`,
			`Running servers: ${this.servers.size}`,
			"",
			"PATH used for spawning:",
			...this.searchPath.split(delimiter).map((dir) => `  ${dir}`),
		];
		if (launcher) {
			const version = spawnSync(launcher.command, [...launcher.baseArgs, "--version"], {
				env: this.spawnEnv(),
				encoding: "utf8",
				timeout: 15000,
			});
			lines.splice(2, 0, `marimo version: ${(version.stdout || "").trim() || "unknown"}`);
		}
		new ErrorModal(
			this.app,
			"marimo diagnostics",
			launcher
				? "marimo looks correctly configured."
				: "marimo could not be found. Set a full path to the marimo or Python executable in settings.",
			lines.join("\n")
		).open();
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<marimoSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// Older versions stored literal defaults; treat them as "auto-detect".
		if (this.settings.marimoPath === "marimo") this.settings.marimoPath = "";
		if (this.settings.pythonPath === "python3") this.settings.pythonPath = "";
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.launcher = null;
	}
}

class MarimoView extends ItemView {
	plugin: marimoPlugin;
	filePath = "";
	url = "";
	private iframe: HTMLIFrameElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: marimoPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = true;
	}

	getViewType() {
		return VIEW_TYPE_MARIMO;
	}

	getDisplayText() {
		return this.filePath ? `marimo: ${this.filePath.split("/").pop()}` : "marimo";
	}

	getIcon() {
		return "play-circle";
	}

	async setState(state: unknown) {
		const s = (state || {}) as { filePath?: string; url?: string };
		this.filePath = s.filePath || "";
		this.url = s.url || "";

		// Restoring a saved workspace: the old server is gone, start a new one.
		if (this.filePath && !this.plugin.getServer(this.filePath)) {
			const server = await this.plugin.restartServer(this.filePath);
			if (server) this.url = server.url;
			else this.url = "";
		} else if (this.filePath) {
			this.url = this.plugin.getServer(this.filePath)!.url;
		}
		this.render();
	}

	getState() {
		return { filePath: this.filePath, url: this.url };
	}

	render() {
		const container = this.contentEl;
		container.empty();
		container.addClass("marimo4obs-view-container");

		const bar = container.createDiv({ cls: "marimo4obs-toolbar" });
		bar.createSpan({ cls: "marimo4obs-path", text: this.filePath });
		const actions = bar.createDiv({ cls: "marimo4obs-actions" });

		const button = (label: string, title: string, onClick: () => void) => {
			const btn = actions.createEl("button", { text: label, cls: "marimo4obs-btn" });
			btn.setAttribute("aria-label", title);
			btn.addEventListener("click", onClick);
			return btn;
		};

		button("Reload", "Reload the marimo editor", () => {
			if (this.iframe) this.iframe.src = this.url;
		});
		button("Restart server", "Restart the marimo server for this notebook", () => {
			void (async () => {
				const server = await this.plugin.restartServer(this.filePath);
				if (server) {
					this.url = server.url;
					this.render();
				}
			})();
		});
		button("Open in browser", "Open this notebook in your default browser", () => {
			if (this.url) window.open(this.url, "_blank");
		});

		if (!this.url) {
			container.createDiv({
				cls: "marimo4obs-empty",
				text: "marimo isn't running for this notebook. Use \"Restart server\" to try again.",
			});
			return;
		}

		this.iframe = container.createEl("iframe", {
			cls: "marimo4obs-iframe",
			attr: {
				src: this.url,
				// marimo needs scripts, its own origin (websockets, storage),
				// forms, popups/modals and file downloads/uploads.
				sandbox:
					"allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads",
				allow: "clipboard-read; clipboard-write",
			},
		});
	}

	async onClose() {
		this.iframe = null;
		if (this.filePath) this.plugin.releaseServer(this.filePath);
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
		const submit = () => {
			this.close();
			this.onSubmit(value);
		};

		new Setting(contentEl).setName("File name").addText((text) => {
			text.setValue(value).onChange((v) => (value = v));
			text.inputEl.focus();
			text.inputEl.select();
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") submit();
			});
		});

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Create").setCta().onClick(submit)
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private titleText: string,
		private message: string,
		private confirmLabel: string,
		private onResult: (confirmed: boolean) => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.titleText });
		contentEl.createEl("p", { text: this.message });

		const buttons = new Setting(contentEl);
		buttons.addButton((btn) =>
			btn.setButtonText("Cancel").onClick(() => {
				this.close();
				this.onResult(false);
			})
		);
		buttons.addButton((btn) =>
			btn
				.setButtonText(this.confirmLabel)
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

/** Shows a message plus a copyable log block. */
class ErrorModal extends Modal {
	constructor(
		app: App,
		private titleText: string,
		private message: string,
		private detail: string
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.titleText });
		contentEl.createEl("p", { text: this.message });
		const detail = this.detail.trim();
		if (detail) {
			contentEl.createEl("pre", { cls: "marimo4obs-log", text: detail });
			new Setting(contentEl).addButton((btn) =>
				btn.setButtonText("Copy details").onClick(() => {
					void navigator.clipboard.writeText(detail);
					new Notice("Copied.");
				})
			);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

class marimoSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: marimoPlugin) {
		super(app, plugin);
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
				"Leave empty to auto-detect. Set a full path (e.g. /path/to/venv/bin/marimo) if marimo lives in a virtualenv."
			)
			.addText((text) =>
				text
					.setPlaceholder("auto-detect")
					.setValue(this.plugin.settings.marimoPath)
					.onChange(async (value) => {
						this.plugin.settings.marimoPath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Python executable path")
			.setDesc(
				"Leave empty to auto-detect. Used to run marimo as a module and to install it. A full venv path works here too."
			)
			.addText((text) =>
				text
					.setPlaceholder("auto-detect")
					.setValue(this.plugin.settings.pythonPath)
					.onChange(async (value) => {
						this.plugin.settings.pythonPath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Reload on external edits")
			.setDesc(
				"Pass --watch so marimo reloads changes made in Obsidian's own editor. marimo warns this can interfere with its auto-save, so it is off by default."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.watchFile).onChange(async (value) => {
					this.plugin.settings.watchFile = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Keep servers running when a pane closes")
			.setDesc("Reopening a notebook is instant, but the Python process stays alive.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.keepServersAlive).onChange(async (value) => {
					this.plugin.settings.keepServersAlive = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Startup timeout (seconds)")
			.setDesc("How long to wait for the marimo server to become ready.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.startupTimeoutSeconds))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.startupTimeoutSeconds = Number.isFinite(parsed)
							? Math.max(10, parsed)
							: DEFAULT_SETTINGS.startupTimeoutSeconds;
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

		new Setting(containerEl)
			.setName("Troubleshooting")
			.setDesc("Check which marimo and Python executables the plugin can see.")
			.addButton((btn) =>
				btn
					.setButtonText("Run diagnostics")
					.setCta()
					.onClick(() => void this.plugin.showDiagnostics())
			);
	}
}
