import { createHash } from "crypto";
import { type App, type TAbstractFile, TFile, Notice } from "obsidian";
import type { BatchDocument, SidecarClient } from "../sidecar/client";
import type { UruSettings } from "../settings";
import { HashStore } from "./hashStore";

const DEBOUNCE_MS = 1_500;
const BATCH_SIZE = 25;

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

	constructor(
		private app: App,
		private client: () => SidecarClient | null,
		private settings: UruSettings,
		statePath: string,
	) {
		this.store = new HashStore(app.vault.adapter, statePath);
		this.recompileIgnore();
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

	async fullIndex(force = false): Promise<void> {
		const client = this.client();
		if (!client) {
			new Notice("Uru backend not ready");
			return;
		}
		if (this.indexing) {
			new Notice("Uru is already indexing");
			return;
		}
		this.indexing = true;
		const notice = new Notice("Uru: indexing…", 0);
		try {
			const files = this.app.vault.getMarkdownFiles().filter((f) => !this.isIgnored(f.path));
			const present = new Set(files.map((f) => f.path));

			// Deletions: tracked notes that no longer exist.
			for (const known of this.store.knownPaths()) {
				if (!present.has(known)) {
					const entry = this.store.get(known);
					await client.forget(known).catch(() => undefined);
					void entry;
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
				notice.setMessage("Uru: nothing to index");
				return;
			}

			let done = 0;
			for (let i = 0; i < docs.length; i += BATCH_SIZE) {
				const batch = docs.slice(i, i + BATCH_SIZE);
				for await (const ev of client.indexFull(batch)) {
					if (ev.event === "progress") {
						notice.setMessage(`Uru: indexing ${done + ev.completed}/${docs.length}`);
					} else if (ev.event === "error") {
						throw new Error(ev.message);
					}
				}
				// Mark the batch indexed. (We re-remember per file to capture doc ids.)
				for (const d of batch) {
					this.store.set(d.external_id, {
						hash: d.metadata!.hash as string,
						docId: this.store.get(d.external_id)?.docId ?? "",
						lastIndexed: Date.now(),
					});
				}
				done += batch.length;
				await this.store.save();
			}
			notice.setMessage(`Uru: indexed ${docs.length} notes`);
		} catch (e) {
			notice.setMessage(`Uru: index failed — ${(e as Error).message}`);
		} finally {
			this.indexing = false;
			setTimeout(() => notice.hide(), 4_000);
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
