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
import { SidecarManager } from "./src/sidecar/manager";
import type { SidecarClient, HealthResponse } from "./src/sidecar/client";
import { Indexer } from "./src/indexing/indexer";
import { RecallView, URU_RECALL_VIEW } from "./src/views/recallView";

export default class UruPlugin extends Plugin {
	settings!: UruSettings;
	private manager: SidecarManager | null = null;
	private indexer: Indexer | null = null;
	private status: HealthResponse["status"] | "uninstalled" = "uninstalled";
	private statusDetail = "";
	private statusBar!: HTMLElement;
	private eventOffs: Array<() => void> = [];

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new UruSettingTab(this.app, this));
		this.statusBar = this.addStatusBarItem();
		this.setStatus("uninstalled", "not started");

		this.registerView(URU_RECALL_VIEW, (leaf: WorkspaceLeaf) => new RecallView(leaf, this));
		this.addRibbonIcon("search", "Uru: recall", () => void this.openRecall());

		this.addCommand({
			id: "uru-recall",
			name: "Recall from knowledge graph",
			callback: () => void this.openRecall(),
		});
		this.addCommand({
			id: "uru-index-vault",
			name: "Index vault",
			callback: () => this.indexVault(),
		});
		this.addCommand({
			id: "uru-restart-backend",
			name: "Restart backend",
			callback: () => void this.runSetup(),
		});

		if (Platform.isMobile) {
			this.setStatus("error", "desktop only");
			new Notice("Uru requires desktop (it runs a local Python backend).");
			return;
		}

		// Boot the backend in the background; never block plugin load.
		this.app.workspace.onLayoutReady(() => void this.boot());
	}

	async onunload(): Promise<void> {
		for (const off of this.eventOffs) off();
		this.eventOffs = [];
		if (this.indexer) await this.indexer.flush().catch(() => undefined);
		if (this.manager) await this.manager.stop();
	}

	// ---- backend lifecycle ----------------------------------------------

	private paths() {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error("Uru requires a local (filesystem) vault.");
		}
		const pluginAbs = join(adapter.getBasePath(), this.manifest.dir ?? "");
		const repoRoot = realpathSync(pluginAbs); // plugin dir is a symlink to the repo in dev
		const sidecarDir = join(repoRoot, "sidecar");
		const dataDir = join(repoRoot, ".uru-data");
		mkdirSync(dataDir, { recursive: true });
		return { repoRoot, sidecarDir, dataDir };
	}

	private async boot(): Promise<void> {
		try {
			this.setStatus("starting", "resolving backend");
			const { repoRoot, sidecarDir, dataDir } = this.paths();
			const backend = await ensureBackend({
				repoRoot,
				sidecarDir,
				dataDir,
				log: (l) => this.setStatus("starting", l),
			});
			await this.persistBackend(backend);
			await this.startSidecar(backend, dataDir);
			await this.startIndexer();
		} catch (e) {
			this.setStatus("error", (e as Error).message);
			new Notice(`Uru setup failed: ${(e as Error).message}`);
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

	private async startSidecar(b: BackendPaths, dataDir: string): Promise<void> {
		this.manager = new SidecarManager({
			pythonPath: b.pythonPath,
			cwd: b.sidecarCwd,
			dbPath: this.settings.dbPath || join(dataDir, "khora.db"),
			chatModelPath: b.chatModelPath,
			embedModelPath: b.embedModelPath,
			embeddingDimension: b.embeddingDimension,
			namespaceId: this.settings.namespaceId,
			extractEntities: this.settings.extractEntities,
			lockPath: join(dataDir, "uru-sidecar.lock"),
		});
		this.manager.onStatus((s, d) => this.setStatus(s, d));
		const health = await this.manager.start();
		// Persist the namespace the sidecar created/resolved, scoped to this vault.
		if (health.namespace_id && health.namespace_id !== this.settings.namespaceId) {
			this.settings.namespaceId = health.namespace_id;
			await this.saveSettings();
		}
	}

	private async startIndexer(): Promise<void> {
		const statePath = `${this.manifest.dir}/index-state.json`;
		this.indexer = new Indexer(this.app, () => this.client(), this.settings, statePath);
		await this.indexer.load();
		this.indexer.registerVaultEvents((off) => this.eventOffs.push(off));
		if (this.settings.autoIndexOnStartup) void this.indexer.fullIndex(false);
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

	async runSetup(): Promise<void> {
		if (this.manager) await this.manager.stop();
		this.manager = null;
		await this.boot();
	}

	indexVault(): void {
		if (!this.indexer) {
			new Notice("Uru backend not ready");
			return;
		}
		this.indexer.recompileIgnore();
		void this.indexer.fullIndex(false);
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

	private setStatus(status: typeof this.status, detail: string): void {
		this.status = status;
		this.statusDetail = detail;
		const icon = status === "ok" ? "✓" : status === "error" ? "✕" : "…";
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
