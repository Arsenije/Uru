import {
	FileSystemAdapter,
	Notice,
	Platform,
	Plugin,
	WorkspaceLeaf,
} from "obsidian";
import { mkdirSync, realpathSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

import { DEFAULT_SETTINGS, UruSettingTab, type UruSettings } from "./src/settings";
import { ensureBackend, type BackendPaths } from "./src/bootstrap/uv";
import { runtimeDir, vaultDataDir } from "./src/paths";
import { SidecarManager } from "./src/sidecar/manager";
import type { SidecarClient, HealthResponse } from "./src/sidecar/client";
import { Indexer, type IndexStatus } from "./src/indexing/indexer";
import { GraphLinker, type LinkStatus } from "./src/graph/linker";
import { RecallView, URU_RECALL_VIEW } from "./src/views/recallView";
import { ChatView, URU_CHAT_VIEW } from "./src/views/chatView";
import { SetupModal } from "./src/views/setupModal";
import { otherActiveVaults, removeVault, touchVault, type VaultRegistryEntry } from "./src/vaultRegistry";

/** What "Danger zone" cleanup removes: just this vault's data, or the shared backend too. */
export type DeleteScope = "vault-only" | "vault-and-runtime";

export default class UruPlugin extends Plugin {
	settings!: UruSettings;
	private manager: SidecarManager | null = null;
	private indexer: Indexer | null = null;
	private linker: GraphLinker | null = null;
	private linkStatus: LinkStatus | null = null;
	private linkStatusListeners = new Set<(s: LinkStatus | null) => void>();
	private status: HealthResponse["status"] | "uninstalled" = "uninstalled";
	private statusDetail = "";
	private indexStatus: IndexStatus | null = null;
	private lastIndexRun: IndexStatus | null = null;
	private indexStatusListeners = new Set<(s: IndexStatus | null) => void>();
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
			name: "Recall from your vault",
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
			id: "uru-resume-indexing",
			name: "Resume indexing",
			checkCallback: (checking) => {
				const canResume = this.settings.indexInterrupted && !this.isIndexing();
				if (canResume && !checking) void this.reindex(false);
				return canResume;
			},
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

		if (Platform.isMobile) {
			this.setStatus("error", "desktop only");
			new Notice("Uru requires desktop (it runs a local AI model on your computer).");
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
			new Notice(`Uru couldn't start: ${(e as Error).message}`);
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

	/** Other vaults still registered as sharing the runtime — never treat "unknown" as safe. */
	async deleteDataPreflight(): Promise<{ otherVaults: VaultRegistryEntry[] | "unknown" }> {
		return { otherVaults: otherActiveVaults(this.settings.vaultKey) };
	}

	/**
	 * Scoped cleanup for the Settings "Danger zone". `vault-only` resets just this
	 * vault's index/db and leaves the shared backend installed and bootable.
	 * `vault-and-runtime` also removes the shared uv venv/models/llama.cpp binary —
	 * it re-checks for other vaults right before doing so, since a vault could start
	 * sharing the runtime in the moments between the confirm dialog opening and the
	 * user clicking through it.
	 */
	async deleteData(scope: DeleteScope): Promise<void> {
		if (!this.settings.vaultKey) return; // nothing set up yet — avoid rmSync on an empty-keyed path
		if (this.manager) {
			await this.manager.stop();
			this.manager = null;
		}
		this.indexer = null;
		this.linker = null;
		try {
			rmSync(vaultDataDir(this.settings.vaultKey), { recursive: true, force: true });
			removeVault(this.settings.vaultKey);
			this.settings.namespaceId = null;
			this.settings.lastIndexedAt = null;
			this.settings.indexInterrupted = false;
			this.settings.indexRemaining = null;

			let deletedRuntime = false;
			if (scope === "vault-and-runtime") {
				const others = otherActiveVaults(this.settings.vaultKey);
				if (others === "unknown" || others.length === 0) {
					rmSync(runtimeDir(), { recursive: true, force: true });
					this.settings.installed = false;
					this.settings.pythonPath = "";
					this.settings.sidecarCwd = "";
					this.settings.chatModelPath = "";
					this.settings.embedModelPath = "";
					deletedRuntime = true;
				} else {
					new Notice("Uru: another vault started using Uru — kept the shared backend.");
				}
			}

			await this.saveSettings();
			this.setStatus("uninstalled", deletedRuntime ? "data deleted" : "vault reset");
			new Notice(
				deletedRuntime
					? "Uru: all data deleted (models, Python environment, and this vault's index). " +
							"You can now safely remove the Uru plugin from Community plugins — nothing is left behind."
					: "Uru: this vault's data was reset. The shared backend was kept — re-run indexing " +
							"or setup to continue using Uru here.",
				8000,
			);
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
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			touchVault({
				vaultKey: this.settings.vaultKey,
				vaultPath: adapter.getBasePath(),
				vaultName: this.app.vault.getName(),
				lastSeen: Date.now(),
			});
		}
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
			(s) => this.setIndexStatus(s),
		);
		await this.indexer.load();
		this.indexer.registerVaultEvents((off) => this.eventOffs.push(off));
		this.linker = new GraphLinker(
			this.app,
			() => this.client(),
			this.settings,
			join(vaultDir, "graph-links.json"),
			(s) => this.setLinkStatus(s),
		);
		this.linker.load();
		if (this.settings.autoIndexOnStartup) {
			void this.reindex(false); // auto-index resumes and clears the flag itself
		} else if (this.settings.indexInterrupted) {
			// Nudge only — never auto-run. Resume via the button, command, or chat.
			new Notice('Uru: indexing didn\'t finish. Run "Resume indexing" to continue.', 8000);
		}
	}

	// ---- public API used by settings / views ----------------------------

	client(): SidecarClient | null {
		return this.manager?.client ?? null;
	}

	statusText(): string {
		return `${this.status}${this.statusDetail ? ` — ${this.statusDetail}` : ""}`;
	}

	/** Raw backend state, for rendering a friendly status label (no detail/UUID). */
	get backendState(): typeof this.status {
		return this.status;
	}

	/** Extra status context (e.g. an error message), sans the raw namespace line. */
	get statusDetailText(): string {
		return this.statusDetail;
	}

	diagnostics(): string {
		return this.manager?.diagnostics ?? "(backend not started)";
	}

	/** Number of notes currently tracked as indexed. */
	indexedCount(): number {
		return this.indexer?.indexedCount() ?? 0;
	}

	/** True while a full index is running. */
	isIndexing(): boolean {
		return this.indexer?.isIndexing ?? false;
	}

	/** True once the backend is up and can accept indexing/chat calls. */
	backendReady(): boolean {
		return this.client() !== null && this.indexer !== null;
	}

	/**
	 * Subscribe to index-status changes (used by views to mirror the status
	 * bar's progress). The callback fires immediately with the current status,
	 * then on every subsequent tick. Returns an unsubscribe fn.
	 */
	onIndexStatus(cb: (s: IndexStatus | null) => void): () => void {
		this.indexStatusListeners.add(cb);
		cb(this.indexStatus);
		return () => this.indexStatusListeners.delete(cb);
	}

	/** Ask the running full index to stop after the current note. */
	stopIndexing(): void {
		this.indexer?.stop();
	}

	// ---- graph linking ---------------------------------------------------

	/** True while a link/unlink pass is running. */
	isLinking(): boolean {
		return this.linker?.isRunning ?? false;
	}

	/** Notes currently carrying Uru links (from the ledger). */
	graphLinkedCount(): number {
		return this.linker?.linkedCount() ?? 0;
	}

	/** Epoch ms of the last completed link pass, or null. */
	graphLastLinkedAt(): number | null {
		return this.linker?.lastLinkedAt() ?? null;
	}

	/** Subscribe to link-status changes; fires immediately with the current status. */
	onLinkStatus(cb: (s: LinkStatus | null) => void): () => void {
		this.linkStatusListeners.add(cb);
		cb(this.linkStatus);
		return () => this.linkStatusListeners.delete(cb);
	}

	stopLinking(): void {
		this.linker?.stop();
	}

	/** Compute + write related-note links into note frontmatter (a change operation). */
	async linkGraph(): Promise<void> {
		if (!this.linker || !this.backendReady()) {
			new Notice("Uru isn't ready yet — one moment…");
			return;
		}
		if (this.isIndexing()) {
			new Notice("Uru: finish indexing first, then link the graph.");
			return;
		}
		if (this.isLinking()) {
			new Notice("Uru is already working on the graph");
			return;
		}
		await this.linker.link();
	}

	/** Remove every Uru link from the vault's frontmatter (undo). */
	async unlinkGraph(): Promise<void> {
		if (!this.linker) {
			new Notice("Uru isn't ready yet — one moment…");
			return;
		}
		if (this.isIndexing()) {
			new Notice("Uru: finish indexing first.");
			return;
		}
		if (this.isLinking()) {
			new Notice("Uru is already working on the graph");
			return;
		}
		await this.linker.unlink();
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
			new Notice("Uru isn't ready yet — one moment…");
			return;
		}
		// A run already owns the interrupted flag and the progress UI — don't let a
		// concurrent call (e.g. auto-index-on-startup + a manual click) stamp state
		// or fire an idle tick that would hide the live progress.
		if (this.isIndexing()) {
			new Notice("Uru is already indexing");
			return;
		}
		this.indexer.recompileIgnore();
		// Mark a run as in-flight BEFORE it starts and persist, so a crash/quit
		// mid-run leaves the flag set → the Resume prompt appears next time.
		this.lastIndexRun = null;
		this.settings.indexInterrupted = true;
		this.settings.indexRemaining = null;
		await this.saveSettings();
		const completed = await this.indexer.fullIndex(force);
		if (completed) {
			this.settings.lastIndexedAt = Date.now();
			this.settings.indexInterrupted = false;
			this.settings.indexRemaining = null;
		} else {
			// Stopped or errored. (Read via a method: setIndexStatus mutates
			// lastIndexRun through the status callback during the await, which TS's
			// flow analysis can't see.)
			const r = this.lastRun();
			if (r) {
				// A run actually began — keep the interrupted flag and snapshot what's left.
				this.settings.indexRemaining = Math.max(0, r.total - r.done);
			} else {
				// No note ever started (e.g. the backend was unavailable) — this isn't
				// a real interruption, so don't leave a misleading "Resume" prompt.
				this.settings.indexInterrupted = false;
				this.settings.indexRemaining = null;
			}
		}
		await this.saveSettings();
		// Re-notify (still idle) so subscribed UI refreshes its summary/labels with
		// the newly-saved state — fullIndex fired its null tick before we saved.
		this.setIndexStatus(null);
	}

	/**
	 * Set the Deep/Quick indexing mode (Deep = full knowledge-graph extraction).
	 * The sidecar reads this once at start, so if the running backend differs we
	 * restart it to pick up the new mode before any (re)index. No-op if unchanged.
	 */
	async applyIndexingMode(deep: boolean): Promise<void> {
		if (this.settings.extractEntities === deep) return;
		this.settings.extractEntities = deep;
		await this.saveSettings();
		await this.restartBackend();
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

	/** Last live status tick of the current/most-recent run (opaque to flow analysis). */
	private lastRun(): IndexStatus | null {
		return this.lastIndexRun;
	}

	private setIndexStatus(s: IndexStatus | null): void {
		this.indexStatus = s;
		if (s) this.lastIndexRun = s; // remember the last live tick for a remaining-count on interruption
		this.renderStatusBar();
		for (const cb of this.indexStatusListeners) cb(s);
	}

	private setLinkStatus(s: LinkStatus | null): void {
		this.linkStatus = s;
		this.renderStatusBar();
		for (const cb of this.linkStatusListeners) cb(s);
	}

	private renderStatusBar(): void {
		if (this.indexStatus) {
			const { done, total, current } = this.indexStatus;
			this.statusBar.setText(`Uru ⏳ ${done}/${total}`);
			this.statusBar.title = `Uru: indexing ${current}\n(run "Uru: Stop indexing" to cancel)`;
			return;
		}
		if (this.linkStatus) {
			const { phase, done, total } = this.linkStatus;
			const verb = phase === "remove" ? "removing links" : "linking";
			this.statusBar.setText(`Uru 🔗 ${done}/${total}`);
			this.statusBar.title = `Uru: ${verb}`;
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
