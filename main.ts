import {
	FileSystemAdapter,
	Notice,
	Platform,
	Plugin,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "fs";
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
import {
	otherActiveVaults,
	pruneOrphanVaultData,
	removeVault,
	touchVault,
	type VaultRegistryEntry,
} from "./src/vaultRegistry";

export default class UruPlugin extends Plugin {
	settings!: UruSettings;
	private manager: SidecarManager | null = null;
	private indexer: Indexer | null = null;
	private status: HealthResponse["status"] | "uninstalled" = "uninstalled";
	private statusDetail = "";
	private statusListeners = new Set<(s: typeof this.status) => void>();
	private indexStatus: IndexStatus | null = null;
	private lastIndexRun: IndexStatus | null = null;
	private indexStatusListeners = new Set<(s: IndexStatus | null) => void>();
	private statusBar!: HTMLElement;
	private eventOffs: Array<() => void> = [];
	// Boot can spend minutes in ensureBackend() (first-run downloads); if the
	// user disables the plugin in that window, onunload() runs with nothing to
	// stop yet. This flag lets the still-running boot notice it's now working
	// for a dead plugin and back out instead of spawning the sidecar and
	// registering vault events that nothing will ever clean up.
	private unloaded = false;
	// Single-flight guard: two overlapping boots would each spawn a sidecar,
	// whose lockfile takeovers then kill each other in an endless restart war.
	private bootPromise: Promise<void> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new UruSettingTab(this.app, this));
		this.statusBar = this.addStatusBarItem();
		this.setStatus("uninstalled", "not started");

		this.registerView(URU_RECALL_VIEW, (leaf: WorkspaceLeaf) => new RecallView(leaf, this));
		this.registerView(URU_CHAT_VIEW, (leaf: WorkspaceLeaf) => new ChatView(leaf, this));
		this.addRibbonIcon("search", "Uru Search", () => void this.openRecall());
		this.addRibbonIcon("message-square", "Uru Chat", () => void this.openChat());

		this.addCommand({
			id: "uru-recall",
			name: "Search in your vault",
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
			name: "Re-index all notes",
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
					new Notice("Stopping after the current note…");
				}
				return active;
			},
		});
		this.addCommand({
			id: "uru-restart-backend",
			name: "Restart Uru",
			callback: () => void this.restartBackend(),
		});

		if (Platform.isMobile) {
			this.setStatus("error", "desktop only");
			new Notice("Uru requires desktop (it runs a local AI model on your computer).");
			return;
		}

		// First run → guided setup modal; otherwise boot silently in background.
		this.app.workspace.onLayoutReady(() => {
			void this.cleanupLegacyUruLinks();
			if (this.settings.installed) void this.bootSilent();
			else this.openSetup();
		});
	}

	async onunload(): Promise<void> {
		this.unloaded = true;
		await this.stopIndexer();
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

	/**
	 * Resolve the backend, start the sidecar, wire indexing. Throws on failure.
	 * Single-flight: a call while a boot is already running joins that boot
	 * (its log output stays wired to the first caller) instead of spawning a
	 * second sidecar on the same database.
	 */
	async runBackend(onLog: (s: string) => void): Promise<void> {
		if (this.bootPromise) return this.bootPromise;
		this.bootPromise = this.doRunBackend(onLog).finally(() => {
			this.bootPromise = null;
		});
		return this.bootPromise;
	}

	private async doRunBackend(onLog: (s: string) => void): Promise<void> {
		this.setStatus("starting", "getting ready");
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
		if (this.unloaded) return; // plugin disabled during bootstrap — don't spawn anything
		await this.persistBackend(backend);
		await this.startSidecar(backend, vaultDir);
		if (this.unloaded) {
			// Disabled while the sidecar was starting, after onunload() found no
			// manager to stop — undo the spawn ourselves.
			await this.manager?.stop();
			this.manager = null;
			return;
		}
		await this.startIndexer(vaultDir);
	}

	/** Background boot (already-installed path); surfaces errors to the status bar. */
	private async bootSilent(): Promise<void> {
		try {
			await this.runBackend((l) => this.setStatus("starting", l));
		} catch (e) {
			// onunload() stopping a mid-boot sidecar surfaces here as a startup
			// failure — the plugin is gone, so don't flash UI for it.
			if (this.unloaded) return;
			this.setStatus("error", (e as Error).message);
			new Notice(`Uru couldn't start — ${(e as Error).message}`);
		}
	}

	openSetup(): void {
		new SetupModal(this.app, this).open();
	}

	async restartBackend(): Promise<void> {
		if (this.bootPromise) {
			new Notice("Uru is already starting — hold on…");
			return;
		}
		if (this.manager) {
			await this.manager.stop();
			this.manager = null;
		}
		await this.bootSilent();
	}

	/** This vault's filesystem path, or undefined on non-file adapters (e.g. mobile). */
	private currentVaultPath(): string | undefined {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
	}

	/** Other vaults still registered as sharing the runtime — never treat "unknown" as safe. */
	async deleteDataPreflight(): Promise<{ otherVaults: VaultRegistryEntry[] | "unknown" }> {
		return { otherVaults: otherActiveVaults(this.settings.vaultKey, this.currentVaultPath()) };
	}

	/**
	 * "Uninstall Uru" cleanup from the Settings "Danger zone": removes this vault's
	 * index/db and, unless another vault still shares it, the uv venv/models/llama.cpp
	 * binary too. It re-checks for other vaults right before removing the shared runtime,
	 * since a vault could start sharing it in the moments between the confirm dialog
	 * opening and the user clicking through it.
	 */
	async deleteData(): Promise<void> {
		if (!this.settings.vaultKey) return; // nothing set up yet — avoid rmSync on an empty-keyed path
		// Let an in-flight boot settle first, so it can't spawn a sidecar or
		// indexer into the directories we're about to delete.
		await this.bootPromise?.catch(() => undefined);
		if (this.manager) {
			await this.manager.stop();
			this.manager = null;
		}
		await this.stopIndexer();
		try {
			rmSync(vaultDataDir(this.settings.vaultKey), { recursive: true, force: true });
			removeVault(this.settings.vaultKey);
			this.settings.namespaceId = null;
			this.settings.lastIndexedAt = null;
			this.settings.indexInterrupted = false;
			this.settings.indexRemaining = null;

			let deletedRuntime = false;
			const others = otherActiveVaults(this.settings.vaultKey, this.currentVaultPath());
			if (others === "unknown" || others.length === 0) {
				rmSync(runtimeDir(), { recursive: true, force: true });
				this.settings.installed = false;
				this.settings.pythonPath = "";
				this.settings.sidecarCwd = "";
				this.settings.chatModelPath = "";
				this.settings.embedModelPath = "";
				deletedRuntime = true;
				// No vault references the shared runtime anymore — sweep any data dirs
				// orphaned by past reinstalls so nothing is left behind on disk.
				pruneOrphanVaultData();
			} else {
				new Notice("Another vault started using Uru — kept the shared local AI service.");
			}

			await this.saveSettings();
			this.setStatus("uninstalled", deletedRuntime ? "data deleted" : "vault reset");
			new Notice(
				deletedRuntime
					? "All Uru data deleted — models, Python environment, and this vault's index. " +
							"It's now safe to uninstall the Uru plugin from Community plugins; nothing is left behind."
					: "This vault's Uru data was removed, but the shared local AI service was kept because " +
							"another vault still uses it. Use \"Repair Uru\" to use Uru here again.",
				8000,
			);
		} catch (e) {
			new Notice(`Cleanup failed — ${(e as Error).message}`);
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

	/** Tear down the current Indexer: unhook vault events, flush pending work. */
	private async stopIndexer(): Promise<void> {
		for (const off of this.eventOffs) off();
		this.eventOffs = [];
		if (this.indexer) {
			this.indexer.stop();
			await this.indexer.flush().catch(() => undefined);
			this.indexer = null;
		}
	}

	private async startIndexer(vaultDir: string): Promise<void> {
		// Every restart/repair path comes through here — retire the previous
		// Indexer first, or its still-registered vault handlers would keep
		// firing alongside the new one's (duplicate /remember calls, and two
		// HashStores clobbering the same index-state.json).
		await this.stopIndexer();
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
		// A restored chat/recall view subscribes during layout-restore, before the
		// indexer exists, so its gate saw an indexed count of 0. Now that the store
		// is loaded, re-emit the current status so those views re-evaluate the gate.
		this.setIndexStatus(this.indexStatus);
		if (this.settings.autoIndexOnStartup) {
			void this.reindex(false); // auto-index resumes and clears the flag itself
		} else if (this.settings.indexInterrupted) {
			// Nudge only — never auto-run. Resume via the button, command, or chat.
			new Notice('Indexing didn\'t finish. Run "Resume indexing" to continue.', 8000);
		}
	}

	// ---- public API used by settings / views ----------------------------

	client(): SidecarClient | null {
		return this.manager?.client ?? null;
	}

	statusText(): string {
		const label =
			this.status === "ok"
				? "Ready"
				: this.status === "starting"
					? "Starting…"
					: this.status === "error"
						? "Something went wrong"
						: "Not set up";
		return `${label}${this.statusDetail ? ` — ${this.statusDetail}` : ""}`;
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
		return this.manager?.diagnostics ?? "(not started)";
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

	/**
	 * Subscribe to backend-status changes (uninstalled/starting/ok/error) so views
	 * can show a loading state while the sidecar boots. Fires immediately with the
	 * current status, then on every change. Returns an unsubscribe fn.
	 */
	onBackendStatus(cb: (s: typeof this.status) => void): () => void {
		this.statusListeners.add(cb);
		cb(this.status);
		return () => this.statusListeners.delete(cb);
	}

	/** Ask the running full index to stop after the current note. */
	stopIndexing(): void {
		this.indexer?.stop();
	}

	/**
	 * One-time migration for the removed graph-linking feature: strip the
	 * "uru-links" frontmatter property it wrote into notes. Gated on the old
	 * ledger file (graph-links.json), which only ever existed for vaults that ran
	 * "Link notes" — everyone else pays nothing. Removes the ledger afterwards so
	 * this never runs twice. Unions the ledger with a live frontmatter scan, same
	 * as the old "Remove Uru links" undo, so it's complete even if the ledger is
	 * stale.
	 */
	private async cleanupLegacyUruLinks(): Promise<void> {
		const PROP = "uru-links";
		if (!this.settings.vaultKey) return;
		const ledgerPath = join(vaultDataDir(this.settings.vaultKey), "graph-links.json");
		if (!existsSync(ledgerPath)) return;
		try {
			const paths = new Set<string>();
			try {
				const d = JSON.parse(readFileSync(ledgerPath, "utf8"));
				if (Array.isArray(d?.paths)) for (const p of d.paths) paths.add(p);
			} catch {
				/* corrupt ledger — the scan below still finds every linked note */
			}
			for (const f of this.app.vault.getMarkdownFiles()) {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
				if (fm && PROP in fm) paths.add(f.path);
			}
			let cleaned = 0;
			for (const path of paths) {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) continue;
				try {
					await this.app.fileManager.processFrontMatter(file, (fm) => {
						if (PROP in fm) {
							delete fm[PROP];
							cleaned++;
						}
					});
				} catch (e) {
					console.warn(`[Uru] failed to remove ${PROP} from ${path}:`, e);
				}
			}
			rmSync(ledgerPath, { force: true });
			rmSync(`${ledgerPath}.tmp`, { force: true });
			if (cleaned > 0) {
				new Notice(
					`Removed the "link notes in the graph" feature — cleaned its ` +
						`"${PROP}" property from ${cleaned} ${cleaned === 1 ? "note" : "notes"}.`,
					8000,
				);
			}
		} catch (e) {
			console.warn("[Uru] uru-links cleanup failed:", e);
		}
	}

	async runSetup(): Promise<void> {
		// Don't yank the sidecar out from under an in-flight boot — let it settle,
		// then the modal's "Install & start" runs a fresh (single-flight) boot.
		await this.bootPromise?.catch(() => undefined);
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
			new Notice("Uru is still starting — one moment…");
			return;
		}
		// A run already owns the interrupted flag and the progress UI — don't let a
		// concurrent call (e.g. auto-index-on-startup + a manual click) stamp state
		// or fire an idle tick that would hide the live progress.
		if (this.isIndexing()) {
			new Notice("Uru is already indexing.");
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
		for (const cb of this.statusListeners) cb(status);
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
