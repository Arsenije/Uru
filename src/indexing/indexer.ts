import { createHash } from "crypto";
import { type App, type TAbstractFile, TFile, Notice } from "obsidian";
import type { BatchDocument, SidecarClient } from "../sidecar/client";
import type { UruSettings } from "../settings";
import { HashStore } from "./hashStore";

const DEBOUNCE_MS = 1_500;

export interface IndexStatus {
	done: number;
	total: number;
	current: string;
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
	 * bar); no per-note notifications. Returns true if it ran to completion.
	 */
	async fullIndex(force = false): Promise<boolean> {
		const client = this.client();
		if (!client) {
			new Notice("Uru backend not ready");
			return false;
		}
		if (this.indexing) {
			new Notice("Uru is already indexing");
			return false;
		}
		this.indexing = true;
		this.cancelRequested = false;
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

			// Changed/new notes only (hash gate).
			const docs: BatchDocument[] = [];
			for (const file of files) {
				const doc = await this.toDocument(file);
				if (!doc) continue;
				const h = doc.metadata!.hash as string;
				if (!force && this.store.isUnchanged(file.path, h)) continue;
				docs.push(doc);
			}

			if (docs.length === 0) {
				new Notice("Uru: everything indexed");
				return true;
			}

			// Index per note via requestUrl (the proven path) — reliable in the
			// Obsidian renderer; progress shown in the status bar only.
			let done = 0;
			let failed = 0;
			let stopped = false;
			for (const doc of docs) {
				if (this.cancelRequested) {
					stopped = true;
					break;
				}
				this.onIndexStatus({ done, total: docs.length, current: doc.title ?? doc.external_id });
				try {
					const res = await client.remember(doc);
					this.store.set(doc.external_id, {
						hash: doc.metadata!.hash as string,
						docId: res.document_id,
						lastIndexed: Date.now(),
					});
				} catch {
					failed++;
				}
				done++;
				if (done % 10 === 0) await this.store.save();
			}
			await this.store.save();
			new Notice(
				stopped
					? `Uru: stopped at ${done}/${docs.length}`
					: `Uru: indexed ${done - failed}/${docs.length} notes` +
							(failed ? ` (${failed} failed)` : ""),
			);
			return !stopped;
		} catch (e) {
			new Notice(`Uru: index failed — ${(e as Error).message}`);
			return false;
		} finally {
			this.indexing = false;
			this.cancelRequested = false;
			this.onIndexStatus(null);
		}
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
			this.store.set(file.path, { hash: h, docId: res.document_id, lastIndexed: Date.now() });
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
