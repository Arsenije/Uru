import {
	FileSystemAdapter,
	Notice,
	Platform,
	Plugin,
	WorkspaceLeaf,
} from "obsidian";
import { mkdirSync, realpathSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

import { DEFAULT_SETTINGS, UruSettingTab, type UruSettings } from "./src/settings";
import { ensureBackend, type BackendPaths } from "./src/bootstrap/uv";
import { runtimeDir, vaultDataDir } from "./src/paths";
import { SidecarManager } from "./src/sidecar/manager";
import type { SidecarClient, HealthResponse } from "./src/sidecar/client";
import { Indexer, type IndexStatus } from "./src/indexing/indexer";
import { RecallView, URU_RECALL_VIEW } from "./src/views/recallView";
import { ChatView, URU_CHAT_VIEW } from "./src/views/chatView";
import { SetupModal } from "./src/views/setupModal";
import { appDataDir } from "./src/paths";
import { rmSync } from "fs";

export default class UruPlugin extends Plugin {
	settings!: UruSettings;
	private manager: SidecarManager | null = null;
	private indexer: Indexer | null = null;
	private status: HealthResponse["status"] | "uninstalled" = "uninstalled";
	private statusDetail = "";
	private indexStatus: IndexStatus | null = null;
	private statusBar!: HTMLElement;
	private eventOffs: Array<() => void> = [];

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new UruSettingTab(this.app, this));
		this.statusBar = this.addStatusBarItem();
		this.setStatus("uninstalled", "not started");

		this.registerView(URU_RECALL_VIEW, (leaf: WorkspaceLeaf) => new RecallView(leaf, this));
		this.registerView(URU_CHAT_VIEW, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));
		this.addRibbonIcon("search", "Uru: recall", () => void this.openRecall());
		this.addRibbonIcon("message-square", "Uru: chat", () => void this.openChat());

		this.addCommand({
			id: "uru-recall",
			name: "Recall from knowledge graph",
			callback: () => void this.openRecall(),
		});
		this.addCommand({
			id: "uru-chat",
			name: "Chat with your vault",
			callback: () => void this.openChat(),
		});
		this.addCommand({
			id: "uru-index-vault",
			name: "Index vault",
			callback: () => this.indexVault(),
		});
		this.addCommand({
			id: "uru-force-reindex",
			name: "Force re-index (all notes)",
			callback: () => void this.reindex(true),
		});
		this.addCommand({
			id: "uru-stop-indexing",
			name: "Stop indexing",
			checkCallback: (checking) => {
				const active = this.indexer?.isIndexing ?? false;
				if (active && !checking) {
					this.indexer?.stop();
					new Notice("Uru: stopping after the current note…");
				}
				return active;
			},
		});
		this.addCommand({
			id: "uru-restart-backend",
			name: "Restart backend",
			callback: () => void this.restartBackend(),
		});
		this.addCommand({
			id: "uru-delete-data",
			name: "Delete all Uru data (models, venv, index)",
			callback: () => void this.deleteAllData(),
		});

		if (Platform.isMobile) {
			this.setStatus("error", "desktop only");
			new Notice("Uru requires desktop (it runs a local Python backend).");
			return;
		}

		// First run → guided setup modal; otherwise boot silently in background.
		this.app.workspace.onLayoutReady(() => {
			if (this.settings.installed) void this.bootSilent();
			else this.openSetup();
		});
	}

	async onunload(): Promise<void> {
		for (const off of this.eventOffs) off();
		this.eventOffs = [];
		if (this.indexer) await this.indexer.flush().catch(() => undefined);
		if (this.manager) await this.manager.stop();
	}

	// ---- backend lifecycle ----------------------------------------------

	private pluginSidecarDir(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("Uru requires a local (filesystem) vault.");
		}
		const pluginAbs = join(adapter.getBasePath(), this.manifest.dir ?? "");
		// In dev the plugin dir is a symlink to the repo; resolve it so the
		// bundled `sidecar/` (and dev .venv/.models) are found.
		return join(realpathSync(pluginAbs), "sidecar");
	}

	/** Resolve the backend, start the sidecar, wire indexing. Throws on failure. */
	async runBackend(onLog: (s: string) => void): Promise<void> {
		this.setStatus("starting", "resolving backend");
		if (!this.settings.vaultKey) {
			this.settings.vaultKey = randomUUID();
			await this.saveSettings();
		}
		const vaultDir = vaultDataDir(this.settings.vaultKey);
		mkdirSync(vaultDir, { recursive: true });
		const backend = await ensureBackend({
			pluginSidecarDir: this.pluginSidecarDir(),
			runtimeDir: runtimeDir(),
			log: onLog,
		});
		await this.persistBackend(backend);
		await this.startSidecar(backend, vaultDir);
		await this.startIndexer(vaultDir);
	}

	/** Background boot (already-installed path); surfaces errors to the status bar. */
	private async bootSilent(): Promise<void> {
		try {
			await this.runBackend((l) => this.setStatus("starting", l));
		} catch (e) {
			this.setStatus("error", (e as Error).message);
			new Notice(`Uru backend failed: ${(e as Error).message}`);
		}
	}

	openSetup(): void {
		new SetupModal(this.app, this).open();
	}

	private async restartBackend(): Promise<void> {
		if (this.manager) {
			await this.manager.stop();
			this.manager = null;
		}
		await this.bootSilent();
	}

	private async deleteAllData(): Promise<void> {
		if (this.manager) {
			await this.manager.stop();
			this.manager = null;
		}
		this.indexer = null;
		try {
			rmSync(appDataDir(), { recursive: true, force: true });
			this.settings.installed = false;
			this.settings.namespaceId = null;
			await this.saveSettings();
			this.setStatus("uninstalled", "data deleted");
			new Notice("Uru: deleted all data (models, venv, index). Re-run setup to reinstall.");
		} catch (e) {
			new Notice(`Uru: cleanup failed — ${(e as Error).message}`);
		}
	}

	private async persistBackend(b: BackendPaths): Promise<void> {
		this.settings.pythonPath = b.pythonPath;
		this.settings.sidecarCwd = b.sidecarCwd;
		this.settings.chatModelPath = b.chatModelPath;
		this.settings.embedModelPath = b.embedModelPath;
		this.settings.embeddingDimension = b.embeddingDimension;
		this.settings.installed = true;
		if (!this.settings.vaultKey) this.settings.vaultKey = randomUUID();
		await this.saveSettings();
	}

	private async startSidecar(b: BackendPaths, vaultDir: string): Promise<void> {
		this.manager = new SidecarManager({
			pythonPath: b.pythonPath,
			cwd: b.sidecarCwd,
			dbPath: this.settings.dbPath || join(vaultDir, "khora.db"),
			llamaServerPath: b.llamaServerBin,
			chatModelPath: b.chatModelPath,
			embedModelPath: b.embedModelPath,
			embeddingDimension: b.embeddingDimension,
			namespaceId: this.settings.namespaceId,
			extractEntities: this.settings.extractEntities,
			lockPath: join(vaultDir, "uru-sidecar.lock"),
		});
		this.manager.onStatus((s, d) => this.setStatus(s, d));
		const health = await this.manager.start();
		// Persist the namespace the sidecar created/resolved, scoped to this vault.
		if (health.namespace_id && health.namespace_id !== this.settings.namespaceId) {
			this.settings.namespaceId = health.namespace_id;
			await this.saveSettings();
		}
	}

	private async startIndexer(vaultDir: string): Promise<void> {
		const statePath = join(vaultDir, "index-state.json");
		this.indexer = new Indexer(
			this.app,
			() => this.client(),
			this.settings,
			statePath,
			(s) => {
				this.indexStatus = s;
				this.renderStatusBar();
			},
		);
		await this.indexer.load();
		this.indexer.registerVaultEvents((off) => this.eventOffs.push(off));
		if (this.settings.autoIndexOnStartup) void this.reindex(false);
	}

	// ---- public API used by settings / views ----------------------------

	client(): SidecarClient | null {
		return this.manager?.client ?? null;
	}

	statusText(): string {
		return `${this.status}${this.statusDetail ? ` — ${this.statusDetail}` : ""}`;
	}

	diagnostics(): string {
		return this.manager?.diagnostics ?? "(backend not started)";
	}

	/** Number of notes currently tracked as indexed. */
	indexedCount(): number {
		return this.indexer?.indexedCount() ?? 0;
	}

	async runSetup(): Promise<void> {
		if (this.manager) await this.manager.stop();
		this.manager = null;
		this.openSetup();
	}

	indexVault(): void {
		void this.reindex(false);
	}

	/** Run a full index. force=true re-sends every note, ignoring the hash gate. */
	async reindex(force = false): Promise<void> {
		if (!this.indexer) {
			new Notice("Uru backend not ready");
			return;
		}
		this.indexer.recompileIgnore();
		const completed = await this.indexer.fullIndex(force);
		if (completed) {
			this.settings.lastIndexedAt = Date.now();
			await this.saveSettings();
		}
	}

	private async openRecall(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(URU_RECALL_VIEW);
		let leaf: WorkspaceLeaf;
		if (existing.length) {
			leaf = existing[0];
		} else {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: URU_RECALL_VIEW, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof RecallView) view.focusInput();
	}

	private async openChat(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(URU_CHAT_VIEW);
		let leaf: WorkspaceLeaf;
		if (existing.length) {
			leaf = existing[0];
		} else {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: URU_CHAT_VIEW, active: true });
		}
		this.app.workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof ChatView) view.focusInput();
	}

	private setStatus(status: typeof this.status, detail: string): void {
		this.status = status;
		this.statusDetail = detail;
		this.renderStatusBar();
	}

	private renderStatusBar(): void {
		if (this.indexStatus) {
			const { done, total, current } = this.indexStatus;
			this.statusBar.setText(`Uru ⏳ ${done}/${total}`);
			this.statusBar.title = `Uru: indexing ${current}\n(run "Uru: Stop indexing" to cancel)`;
			return;
		}
		const icon = this.status === "ok" ? "✓" : this.status === "error" ? "✕" : "…";
		this.statusBar.setText(`Uru ${icon}`);
		this.statusBar.title = `Uru: ${this.statusText()}`;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
