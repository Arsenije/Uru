import { createHash } from "crypto";
import { type App, type TAbstractFile, TFile, Notice } from "obsidian";
import type { BatchDocument, RememberResult, SidecarClient } from "../sidecar/client";
import type { UruSettings } from "../settings";
import { HashStore } from "./hashStore";

const DEBOUNCE_MS = 1_500;

export interface IndexStatus {
	done: number;
	total: number;
	current: string;
	/** Epoch ms when this run's note loop began — lets consumers derive an ETA. */
	startedAt: number;
}

/** Outcome of a full-index run. A run is only "complete" if it processed the
 *  whole queue AND every note was durably recorded (`succeeded === total`,
 *  `failed === 0`, not stopped) — this is what lets the caller decide whether to
 *  clear the interrupted flag or keep the run resumable. */
export interface FullIndexResult {
	/** Notes that needed (re)indexing this run. */
	total: number;
	/** Notes recorded as indexed (a durable success). */
	succeeded: number;
	/** Notes that errored/timed out — NOT recorded, so a later run retries them. */
	failed: number;
	/** True if the user stopped the run before it finished the queue. */
	stopped: boolean;
}

/**
 * Estimated seconds remaining, or null during warm-up (too few notes/too little
 * elapsed for a stable figure). Uses a cumulative average (notes/sec since the
 * run began): stateless — reads only the status — so both UIs stay pure. It lags
 * a slow tail but never oscillates; if a snappier estimate is ever needed, add a
 * `recentRate` field computed from a small ring buffer in fullIndex and prefer it.
 */
export function etaSeconds(s: IndexStatus): number | null {
	const remaining = s.total - s.done;
	if (remaining <= 0) return null;
	const elapsed = (Date.now() - s.startedAt) / 1000;
	if (s.done < 3 || elapsed < 4) return null;
	const rate = s.done / elapsed; // notes/sec
	if (rate <= 0) return null;
	return remaining / rate;
}

/** Human-friendly ETA, e.g. "under a minute", "about 4 min left", "about 1 h 10 min left". */
export function formatEta(seconds: number): string {
	if (seconds < 45) return "under a minute";
	const mins = Math.round(seconds / 60);
	if (mins < 60) return `about ${mins} min left`;
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return m ? `about ${h} h ${m} min left` : `about ${h} h left`;
}

/** Compile a single glob (`**`, `*`, `?`) to a RegExp anchored to the full path. */
function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

export class Indexer {
	private store: HashStore;
	private ignore: RegExp[] = [];
	private pending = new Map<string, ReturnType<typeof setTimeout>>();
	private indexing = false;
	private cancelRequested = false;

	constructor(
		private app: App,
		private client: () => SidecarClient | null,
		private settings: UruSettings,
		statePath: string,
		private onIndexStatus: (s: IndexStatus | null) => void = () => {},
	) {
		this.store = new HashStore(statePath);
		this.recompileIgnore();
	}

	get isIndexing(): boolean {
		return this.indexing;
	}

	/** Number of notes currently tracked as indexed. */
	indexedCount(): number {
		return this.store.count();
	}

	/** Request the in-progress full index to stop after the current note. */
	stop(): void {
		if (this.indexing) this.cancelRequested = true;
	}

	async load(): Promise<void> {
		await this.store.load();
	}

	async flush(): Promise<void> {
		await this.store.save();
	}

	recompileIgnore(): void {
		this.ignore = this.settings.ignoreGlobs.map(globToRegExp);
	}

	private isIgnored(path: string): boolean {
		if (!path.endsWith(".md")) return true;
		return this.ignore.some((re) => re.test(path));
	}

	private hash(content: string): string {
		return createHash("sha256").update(content).digest("hex").slice(0, 32);
	}

	/** Read a file, optionally stripping leading YAML frontmatter. */
	private async readContent(file: TFile): Promise<string> {
		const raw = await this.app.vault.cachedRead(file);
		if (this.settings.includeFrontmatter) return raw;
		return raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trimStart();
	}

	private async toDocument(file: TFile): Promise<BatchDocument | null> {
		const content = await this.readContent(file);
		if (!content.trim()) return null;
		return {
			external_id: file.path,
			content,
			title: file.basename,
			metadata: { mtime: file.stat.mtime, hash: this.hash(content) },
		};
	}

	// ---- full index ------------------------------------------------------

	/**
	 * Incremental full index: walks the vault but only (re)sends new/changed
	 * notes (content-hash gate) and forgets deleted ones. Pass force=true to
	 * re-index everything. Progress is reported via the status callback (status
	 * bar); no per-note notifications. Returns per-note success/failure counts so
	 * the caller can tell a clean finish from a partial one — a note is only
	 * counted as `succeeded` once it's been durably recorded in the store, never
	 * merely because it was attempted.
	 */
	async fullIndex(force = false): Promise<FullIndexResult> {
		const client = this.client();
		if (!client) {
			new Notice("Uru backend not ready");
			return { total: 0, succeeded: 0, failed: 0, stopped: true };
		}
		if (this.indexing) {
			new Notice("Uru is already indexing");
			return { total: 0, succeeded: 0, failed: 0, stopped: true };
		}
		this.indexing = true;
		this.cancelRequested = false;
		let total = 0;
		let succeeded = 0;
		let failed = 0;
		let stopped = false;
		try {
			const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isIgnored(f.path));
			const present = new Set(files.map((f) => f.path));

			// Deletions: tracked notes that no longer exist.
			for (const known of this.store.knownPaths()) {
				if (!present.has(known)) {
					await client.forget(known).catch(() => undefined);
					this.store.delete(known);
				}
			}

			// Changed/new notes only (content-hash gate), plus notes whose
			// extraction mode changed (Lite ↔ Full). khora dedups by content
			// checksum and skips already-COMPLETED docs, so re-sending a note with
			// unchanged content is a no-op — to genuinely re-extract we drop the
			// existing doc first (forgetFirst) so khora re-ingests it from scratch.
			const mode = this.settings.extractEntities;
			const docs: Array<{ doc: BatchDocument; forgetFirst: boolean }> = [];
			for (const file of files) {
				const doc = await this.toDocument(file);
				if (!doc) continue;
				const h = doc.metadata!.hash as string;
				const known = this.store.get(file.path);
				const contentSame = known?.hash === h;
				// Legacy entries (mode undefined) are treated as matching, so an
				// upgrade doesn't trigger a surprise full re-extraction.
				const modeSame = known?.extractEntities === undefined || known.extractEntities === mode;
				if (!force && contentSame && modeSame) continue;
				const forgetFirst = !!known && contentSame && (force || !modeSame);
				docs.push({ doc, forgetFirst });
			}

			total = docs.length;
			if (total === 0) {
				new Notice("Uru: everything indexed");
				return { total: 0, succeeded: 0, failed: 0, stopped: false };
			}

			// Index per note via requestUrl (the proven path) — reliable in the
			// Obsidian renderer; progress shown in the status bar only.
			const failures: string[] = [];
			const startedAt = Date.now();
			for (const { doc, forgetFirst } of docs) {
				if (this.cancelRequested) {
					stopped = true;
					break;
				}
				const done = succeeded + failed;
				this.onIndexStatus({ done, total, current: doc.title ?? doc.external_id, startedAt });
				try {
					const res = await this.rememberWithRetry(client, doc, forgetFirst);
					// Only now — after a durable success — is the note recorded. A note
					// the backend timed out on stays unrecorded, so the next run retries it.
					this.store.set(doc.external_id, {
						hash: doc.metadata!.hash as string,
						docId: res.document_id,
						lastIndexed: Date.now(),
						extractEntities: mode,
					});
					succeeded++;
				} catch (e) {
					failed++;
					failures.push(`${doc.external_id}: ${(e as Error).message}`);
				}
				if ((succeeded + failed) % 10 === 0) await this.store.save();
			}
			if (failures.length) console.warn("[Uru] notes that failed to index:\n" + failures.join("\n"));
			await this.store.save();
			if (stopped) {
				new Notice(`Uru: stopped — indexed ${succeeded} of ${total} note${total === 1 ? "" : "s"} so far.`);
			} else if (failed) {
				new Notice(
					`Uru: indexed ${succeeded} of ${total} notes — ${failed} failed. ` +
						'Run "Index new & changed" again to retry the rest.',
					10000,
				);
			} else {
				new Notice(`Uru: indexed ${succeeded} note${succeeded === 1 ? "" : "s"}.`);
			}
			return { total, succeeded, failed, stopped };
		} catch (e) {
			new Notice(`Uru: index failed — ${(e as Error).message}`);
			// Report whatever we managed before the error, marked not-complete so the
			// caller keeps the run resumable.
			return { total, succeeded, failed, stopped: true };
		} finally {
			this.indexing = false;
			this.cancelRequested = false;
			this.onIndexStatus(null);
		}
	}

	/**
	 * Send one note, retrying a couple of times to ride out a transient failure —
	 * a sleep/wake boundary or a brief sidecar crash-restart. Before each retry we
	 * wait (briefly) for the backend to report healthy, so we don't burn attempts
	 * against a down port. `forget` runs only on the first try: khora dedups by
	 * content checksum and skips COMPLETED docs, so a retried remember after a
	 * partial success is a cheap no-op — re-forgetting could drop a fresh write.
	 */
	private async rememberWithRetry(
		client: SidecarClient,
		doc: BatchDocument,
		forgetFirst: boolean,
	): Promise<RememberResult> {
		const backoff = [500, 1_500];
		let forgotten = false;
		let lastErr: unknown;
		for (let attempt = 0; attempt <= backoff.length; attempt++) {
			if (this.cancelRequested) throw new Error("cancelled");
			try {
				if (forgetFirst && !forgotten) {
					await client.forget(doc.external_id).catch(() => undefined);
					forgotten = true;
				}
				return await client.remember(doc);
			} catch (e) {
				lastErr = e;
				if (attempt === backoff.length) break;
				await this.sleep(backoff[attempt]);
				await this.waitForHealth(client, 10_000);
			}
		}
		throw lastErr;
	}

	/** Poll /health until "ok" or the budget elapses (absorbs a mid-restart backend). */
	private async waitForHealth(client: SidecarClient, budgetMs: number): Promise<void> {
		const deadline = Date.now() + budgetMs;
		while (Date.now() < deadline && !this.cancelRequested) {
			const h = await client.health().catch(() => null);
			if (h?.status === "ok") return;
			await this.sleep(500);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	// ---- incremental -----------------------------------------------------

	registerVaultEvents(register: (off: () => void) => void): void {
		const { vault } = this.app;
		const onChange = (file: TAbstractFile) => {
			if (file instanceof TFile && !this.isIgnored(file.path)) this.debounce(file);
		};
		const refs = [
			vault.on("create", onChange),
			vault.on("modify", onChange),
			vault.on("delete", (f) => {
				if (f instanceof TFile) void this.handleDelete(f.path);
			}),
			vault.on("rename", (f, oldPath) => {
				if (f instanceof TFile) void this.handleRename(f, oldPath);
			}),
		];
		for (const ref of refs) register(() => vault.offref(ref));
	}

	private debounce(file: TFile): void {
		const prev = this.pending.get(file.path);
		if (prev) clearTimeout(prev);
		this.pending.set(
			file.path,
			setTimeout(() => {
				this.pending.delete(file.path);
				void this.reindexOne(file);
			}, DEBOUNCE_MS),
		);
	}

	private async reindexOne(file: TFile): Promise<void> {
		const client = this.client();
		if (!client) return;
		const doc = await this.toDocument(file);
		if (!doc) return;
		const h = doc.metadata!.hash as string;
		if (this.store.isUnchanged(file.path, h)) return;
		try {
			const res = await client.remember(doc);
			this.store.set(file.path, {
				hash: h,
				docId: res.document_id,
				lastIndexed: Date.now(),
				extractEntities: this.settings.extractEntities,
			});
			await this.store.save();
		} catch {
			/* surfaced via status; will retry on next change */
		}
	}

	private async handleDelete(path: string): Promise<void> {
		const client = this.client();
		if (!client) return;
		const entry = this.store.get(path);
		await client.forget(path).catch(() => undefined);
		void entry;
		this.store.delete(path);
		await this.store.save();
	}

	private async handleRename(file: TFile, oldPath: string): Promise<void> {
		await this.handleDelete(oldPath);
		if (!this.isIgnored(file.path)) await this.reindexOne(file);
	}
}
