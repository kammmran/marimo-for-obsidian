import {
	App,
	FileSystemAdapter,
	FileView,
	ItemView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	ViewStateResult,
	WorkspaceLeaf,
} from "obsidian";
import { ChildProcess, execFile, spawn, spawnSync } from "child_process";
import { connect, createServer } from "net";
import { existsSync } from "fs";
import { delimiter, join } from "path";
import { homedir } from "os";

const VIEW_TYPE_MARIMO = "marimo-notebooks-view";

/**
 * marimo serves a notebook two ways: `edit` is the notebook editor, `run`
 * serves it as an app - the read-only, code-free "website" view.
 */
type MarimoMode = "edit" | "run";

const MODE_LABEL: Record<MarimoMode, string> = { edit: "Edit", run: "App" };

function isMarimoMode(value: unknown): value is MarimoMode {
	return value === "edit" || value === "run";
}

interface MarimoNotebooksSettings {
	marimoPath: string;
	pythonPath: string;
	extraArgs: string;
	watchFile: boolean;
	keepServersAlive: boolean;
	startupTimeoutSeconds: number;
	defaultMode: MarimoMode;
	includeCodeInApp: boolean;
	registerPyExtension: boolean;
}

const DEFAULT_SETTINGS: MarimoNotebooksSettings = {
	marimoPath: "",
	pythonPath: "",
	extraArgs: "",
	watchFile: false,
	keepServersAlive: false,
	startupTimeoutSeconds: 60,
	defaultMode: "edit",
	includeCodeInApp: false,
	registerPyExtension: true,
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
	mode: MarimoMode;
	port: number;
}

/** Edit and app mode need separate marimo processes, so both key the map. */
function serverKey(filePath: string, mode: MarimoMode): string {
	return `${mode}:${filePath}`;
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

/**
 * True once something accepts a TCP connection on the port.
 *
 * Readiness is probed at the socket level rather than with an HTTP request:
 * Obsidian's renderer runs on the `app://obsidian.md` origin, and marimo sends
 * no CORS headers, so a `fetch` at its server is blocked by the browser even
 * while the server is happily responding.
 */
function canConnect(port: number, timeoutMs = 1000): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ port, host: "127.0.0.1" });
		const finish = (ok: boolean) => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.once("timeout", () => finish(false));
	});
}

/** Picks up the "URL: http://localhost:2718" line marimo prints on startup. */
function parseMarimoUrl(log: string): string | null {
	const match = /URL:\s*(https?:\/\/\S+)/i.exec(log);
	return match ? match[1].replace(/[.,)\]]+$/, "") : null;
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

export default class MarimoNotebooksPlugin extends Plugin {
	settings!: MarimoNotebooksSettings;
	servers: Map<string, RunningServer> = new Map();
	/** PATH used for every spawned process; widened on load. */
	private searchPath: string = process.env.PATH || "";
	private launcher: Launcher | null = null;
	private startupLog: Map<string, string> = new Map();

	async onload() {
		await this.loadSettings();
		void this.refreshSearchPath();

		this.registerView(VIEW_TYPE_MARIMO, (leaf) => new MarimoView(leaf, this));

		// Obsidian only opens file types it knows about, so .py files are
		// otherwise invisible in the vault. Registering the extension makes
		// them appear in the file explorer, in search results and in links,
		// and makes clicking one open marimo directly.
		if (this.settings.registerPyExtension) {
			try {
				this.registerExtensions(["py"], VIEW_TYPE_MARIMO);
			} catch (e) {
				// Another plugin already claims .py; commands still work.
				console.warn("[Marimo Notebooks] Couldn't register the .py extension", e);
			}
		}

		this.addCommand({
			id: "open-in-marimo",
			name: "Open current notebook in marimo editor",
			checkCallback: (checking) => {
				const file = this.activePythonFile();
				if (checking) return !!file;
				if (file) void this.openMarimoNotebook(file, "edit");
				return true;
			},
		});

		this.addCommand({
			id: "open-in-marimo-app",
			name: "Open current notebook as marimo app",
			checkCallback: (checking) => {
				const file = this.activePythonFile();
				if (checking) return !!file;
				if (file) void this.openMarimoNotebook(file, "run");
				return true;
			},
		});

		this.addCommand({
			id: "toggle-marimo-mode",
			name: "Toggle between marimo editor and app",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarimoView);
				if (checking) return !!view?.file;
				void view?.setMode(view.mode === "run" ? "edit" : "run");
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
						item.setTitle("Open in marimo editor")
							.setIcon("play-circle")
							.onClick(() => void this.openMarimoNotebook(file, "edit"));
					});
					menu.addItem((item) => {
						item.setTitle("Open as marimo app")
							.setIcon("app-window")
							.onClick(() => void this.openMarimoNotebook(file, "run"));
					});
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) this.stopServersFor(oldPath);
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) this.stopServersFor(file.path);
			})
		);

		this.addRibbonIcon("play-circle", "New marimo notebook", () => {
			new NewNotebookModal(this.app, (name) => void this.createNewNotebook(name)).open();
		});

		this.addSettingTab(new MarimoNotebooksSettingTab(this.app, this));
	}

	onunload() {
		this.stopAllServers();
	}

	/** The active file when it is a Python notebook, else null. */
	private activePythonFile(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		return file && file.extension === "py" ? file : null;
	}

	/** Stops every mode's server for one notebook. */
	stopServersFor(filePath: string) {
		this.stopServer(filePath, "edit");
		this.stopServer(filePath, "run");
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
				"Couldn't find Python. Install Python 3, then set its full path in Marimo Notebooks settings (run \"Diagnose marimo setup\" for details).",
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
					console.error("[Marimo Notebooks] pip install failed:\n" + output);
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

	async openMarimoNotebook(file: TFile, mode: MarimoMode = this.settings.defaultMode) {
		const leaf = this.app.workspace.getLeaf("tab");
		// The view starts the server itself, so notebooks opened from the file
		// explorer take exactly the same path as ones opened from a command.
		await leaf.setViewState({
			type: VIEW_TYPE_MARIMO,
			active: true,
			state: { file: file.path, mode },
		});
		await this.app.workspace.revealLeaf(leaf);
	}

	/** Returns the server for this notebook and mode, starting it if needed. */
	async ensureServer(filePath: string, mode: MarimoMode): Promise<RunningServer | null> {
		const existing = this.servers.get(serverKey(filePath, mode));
		if (existing) return existing;

		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			new Notice(`${filePath} no longer exists.`);
			return null;
		}
		if (!(await this.ensureMarimoAvailable())) return null;

		const notice = new Notice(
			`Starting marimo ${mode === "run" ? "app" : "editor"} for ${file.name}...`,
			0
		);
		try {
			return await this.startServer(file, mode);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			const log = this.startupLog.get(serverKey(filePath, mode)) || "";
			console.error("[Marimo Notebooks] " + message + "\n" + log);
			new ErrorModal(this.app, "Couldn't start marimo", message, log).open();
			return null;
		} finally {
			notice.hide();
		}
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

	/**
	 * Waits until marimo is serving, and returns the URL to embed. marimo
	 * falls back to another port when the requested one is taken, so its own
	 * printed URL wins over the port we asked for.
	 */
	private async waitForReady(
		port: number,
		deadline: number,
		proc: ChildProcess,
		currentLog: () => string
	): Promise<string> {
		for (;;) {
			if (proc.exitCode !== null || proc.signalCode !== null) {
				throw new Error(`marimo exited before it finished starting (code ${proc.exitCode}).`);
			}

			const announced = parseMarimoUrl(currentLog());
			const announcedPort = announced ? Number(new URL(announced).port) : NaN;
			const target = Number.isFinite(announcedPort) && announcedPort > 0 ? announcedPort : port;
			if (await canConnect(target)) {
				return `http://127.0.0.1:${target}`;
			}

			if (Date.now() > deadline) {
				throw new Error(
					`marimo didn't become ready within ${this.settings.startupTimeoutSeconds}s.`
				);
			}
			await new Promise((r) => window.setTimeout(r, 300));
		}
	}

	private async startServer(file: TFile, mode: MarimoMode): Promise<RunningServer> {
		const key = serverKey(file.path, mode);
		const launcher = this.resolveLauncher();
		if (!launcher) throw new Error("marimo isn't available. Run \"Diagnose marimo setup\".");

		const basePath = this.getVaultBasePath();
		const absolutePath = join(basePath, file.path);
		const port = await this.freePort();

		const args = [
			...launcher.baseArgs,
			// "edit" opens the notebook editor; "run" serves it as an app.
			mode,
			absolutePath,
			"--headless",
			"--no-token",
			// `marimo run` has no --skip-update-check; it is an edit-only flag.
			...(mode === "edit" ? ["--skip-update-check"] : []),
			"--host",
			"127.0.0.1",
			"-p",
			String(port),
			...(this.settings.watchFile ? ["--watch"] : []),
			...(mode === "run" && this.settings.includeCodeInApp ? ["--include-code"] : []),
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
			this.startupLog.set(key, log);
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
			this.servers.delete(key);
		});

		const deadline = Date.now() + Math.max(10, this.settings.startupTimeoutSeconds) * 1000;
		let url: string;
		try {
			url = await Promise.race([
				this.waitForReady(port, deadline, proc, () => log),
				spawnFailure,
			]);
		} catch (e) {
			this.killProcess(proc);
			const detail = log.trim();
			const hint = /command not found|No such file|not recognized/i.test(detail)
				? ` Marimo Notebooks used "${launcher.label}".`
				: "";
			throw new Error((e instanceof Error ? e.message : String(e)) + hint);
		}

		const server: RunningServer = {
			process: proc,
			url,
			filePath: file.path,
			mode,
			// marimo may have landed on a different port than the one asked for.
			port: Number(new URL(url).port) || port,
		};
		this.servers.set(key, server);
		this.startupLog.delete(key);
		return server;
	}

	getServer(filePath: string, mode: MarimoMode): RunningServer | undefined {
		return this.servers.get(serverKey(filePath, mode));
	}

	/** Called when a marimo pane closes or switches mode. */
	releaseServer(filePath: string, mode: MarimoMode, except?: MarimoView) {
		if (this.settings.keepServersAlive) return;
		// Another pane may still be showing the same notebook in the same mode.
		const stillOpen = this.app.workspace
			.getLeavesOfType(VIEW_TYPE_MARIMO)
			.map((leaf) => leaf.view)
			.some(
				(view) =>
					view instanceof MarimoView &&
					view !== except &&
					view.file?.path === filePath &&
					view.mode === mode
			);
		if (stillOpen) return;
		this.stopServer(filePath, mode);
	}

	stopServer(filePath: string, mode: MarimoMode) {
		const key = serverKey(filePath, mode);
		const server = this.servers.get(key);
		if (server) {
			this.killProcess(server.process);
			this.servers.delete(key);
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
		const saved = (await this.loadData()) as Partial<MarimoNotebooksSettings> | null;
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

class MarimoView extends FileView {
	plugin: MarimoNotebooksPlugin;
	mode: MarimoMode;
	url = "";
	private iframe: HTMLIFrameElement | null = null;
	private starting = false;

	constructor(leaf: WorkspaceLeaf, plugin: MarimoNotebooksPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.mode = plugin.settings.defaultMode;
		this.navigation = true;
	}

	getViewType() {
		return VIEW_TYPE_MARIMO;
	}

	/** Claims .py so Obsidian routes Python files here. */
	canAcceptExtension(extension: string) {
		return extension === "py";
	}

	getDisplayText() {
		if (!this.file) return "marimo";
		return this.mode === "run" ? `${this.file.basename} (app)` : this.file.basename;
	}

	getIcon() {
		return this.mode === "run" ? "app-window" : "play-circle";
	}

	async setState(state: unknown, result: ViewStateResult) {
		const mode = (state as { mode?: unknown } | null)?.mode;
		if (isMarimoMode(mode)) this.mode = mode;
		// FileView.setState loads state.file, which calls onLoadFile below.
		await super.setState(state, result);
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), mode: this.mode };
	}

	async onLoadFile(file: TFile) {
		await this.launch();
	}

	async onUnloadFile(file: TFile) {
		this.iframe = null;
		this.url = "";
		this.plugin.releaseServer(file.path, this.mode, this);
	}

	async onRename(file: TFile) {
		await super.onRename(file);
		// marimo was started against the old path, so serve the new one.
		await this.launch();
	}

	/** Switches between the notebook editor and the app view. */
	async setMode(mode: MarimoMode) {
		if (mode === this.mode || !this.file) return;
		const previous = this.mode;
		this.mode = mode;
		this.plugin.releaseServer(this.file.path, previous, this);
		// Refresh the tab title/icon, which are derived from the mode.
		(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
		this.app.workspace.requestSaveLayout();
		await this.launch();
	}

	private async launch() {
		const file = this.file;
		const mode = this.mode;
		if (!file) return;
		this.starting = true;
		this.url = "";
		this.render();

		const server = await this.plugin.ensureServer(file.path, mode);

		// The pane may have been closed, switched mode, or pointed at another
		// notebook while the server was starting; that launch owns the render.
		if (this.file !== file || this.mode !== mode) return;
		this.starting = false;
		this.url = server ? server.url : "";
		this.render();
	}

	render() {
		const container = this.contentEl;
		container.empty();
		container.addClass("marimo-notebooks-view-container");

		const bar = container.createDiv({ cls: "marimo-notebooks-toolbar" });
		bar.createSpan({ cls: "marimo-notebooks-path", text: this.file?.path ?? "" });
		const actions = bar.createDiv({ cls: "marimo-notebooks-actions" });

		const modeSwitch = actions.createDiv({ cls: "marimo-notebooks-modes" });
		for (const mode of ["edit", "run"] as MarimoMode[]) {
			const btn = modeSwitch.createEl("button", {
				text: MODE_LABEL[mode],
				cls: "marimo-notebooks-btn marimo-notebooks-mode-btn",
			});
			btn.setAttribute(
				"aria-label",
				mode === "run"
					? "Serve this notebook as an app (no code)"
					: "Open the marimo notebook editor"
			);
			if (mode === this.mode) btn.addClass("is-active");
			btn.addEventListener("click", () => void this.setMode(mode));
		}

		const button = (label: string, title: string, onClick: () => void) => {
			const btn = actions.createEl("button", { text: label, cls: "marimo-notebooks-btn" });
			btn.setAttribute("aria-label", title);
			btn.addEventListener("click", onClick);
			return btn;
		};

		button("Reload", "Reload the marimo view", () => {
			if (this.iframe) this.iframe.src = this.url;
		});
		button("Restart server", "Restart the marimo server for this notebook", () => {
			void (async () => {
				if (!this.file) return;
				this.plugin.stopServer(this.file.path, this.mode);
				await this.launch();
			})();
		});
		button("Open in browser", "Open this notebook in your default browser", () => {
			if (this.url) window.open(this.url, "_blank");
		});

		if (!this.url) {
			container.createDiv({
				cls: "marimo-notebooks-empty",
				text: this.starting
					? "Starting marimo..."
					: 'marimo isn\'t running for this notebook. Use "Restart server" to try again.',
			});
			return;
		}

		this.iframe = container.createEl("iframe", {
			cls: "marimo-notebooks-iframe",
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
		if (this.file) this.plugin.releaseServer(this.file.path, this.mode, this);
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
		this.setTitle("New marimo notebook");

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
		this.setTitle(this.titleText);
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
		this.setTitle(this.titleText);
		contentEl.createEl("p", { text: this.message });
		const detail = this.detail.trim();
		if (detail) {
			contentEl.createEl("pre", { cls: "marimo-notebooks-log", text: detail });
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

class MarimoNotebooksSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: MarimoNotebooksPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			text: "Marimo Notebooks is an unofficial, community-built integration and is not affiliated with or endorsed by the marimo project.",
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
			.setName("Default view")
			.setDesc(
				"How a notebook opens: the marimo editor, or the app view, which serves it like a website with the code hidden."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("edit", "Editor")
					.addOption("run", "App")
					.setValue(this.plugin.settings.defaultMode)
					.onChange(async (value) => {
						if (!isMarimoMode(value)) return;
						this.plugin.settings.defaultMode = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show code in the app view")
			.setDesc("Pass --include-code so readers can expand the Python behind each cell.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.includeCodeInApp).onChange(async (value) => {
					this.plugin.settings.includeCodeInApp = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Open .py files in the vault")
			.setDesc(
				"Registers the .py extension so Python files show up in the file explorer and open in marimo. Takes effect after Obsidian is restarted or the plugin is reloaded."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.registerPyExtension).onChange(async (value) => {
					this.plugin.settings.registerPyExtension = value;
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
