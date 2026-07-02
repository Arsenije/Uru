import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "fs";
import { type App, Notice, TFile } from "obsidian";
import type { SidecarClient } from "../sidecar/client";
import type { UruSettings } from "../settings";
import { globToRegExp } from "../indexing/indexer";

/**
 * The single frontmatter property Uru owns. All graph edges Uru contributes live
 * here as a list of [[wikilinks]], so adding and removing them is fully isolated
 * from the note body and any other property — the basis for reliable undo.
 */
export const URU_LINK_PROP = "uru-links";

export interface LinkStatus {
	/** "compute" while the sidecar embeds; "apply"/"remove" while we write files. */
	phase: "compute" | "apply" | "remove";
	done: number;
	total: number;
	current: string;
	startedAt: number;
}

interface LedgerData {
	/** Vault-relative paths whose frontmatter currently carries uru-links. */
	paths: string[];
	linkedAt: number | null;
}

/**
 * Persists the set of notes Uru has written links into (outside the vault, next
 * to the index state). Undo iterates this ledger; a full-vault scan is the
 * fallback if it's ever lost, since the property name itself marks Uru's edges.
 */
class LinkLedger {
	private data: LedgerData = { paths: [], linkedAt: null };
	private loaded = false;

	constructor(private path: string) {}

	load(): void {
		const tmp = `${this.path}.tmp`;
		this.data = this.readIfValid(this.path) ?? this.readIfValid(tmp) ?? { paths: [], linkedAt: null };
		if (existsSync(tmp)) {
			try {
				unlinkSync(tmp);
			} catch {
				/* best-effort */
			}
		}
		this.loaded = true;
	}

	private readIfValid(path: string): LedgerData | null {
		try {
			if (!existsSync(path)) return null;
			const d = JSON.parse(readFileSync(path, "utf8"));
			if (Array.isArray(d?.paths)) return { paths: d.paths, linkedAt: d.linkedAt ?? null };
			return null;
		} catch {
			return null;
		}
	}

	paths(): string[] {
		return this.data.paths;
	}
	count(): number {
		return this.data.paths.length;
	}
	linkedAt(): number | null {
		return this.data.linkedAt;
	}

	set(paths: string[], linkedAt: number | null): void {
		this.data = { paths, linkedAt };
	}

	save(): void {
		if (!this.loaded) return;
		const tmp = `${this.path}.tmp`;
		const fd = openSync(tmp, "w");
		try {
			writeSync(fd, JSON.stringify(this.data));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, this.path);
	}
}

/**
 * Adds/removes Uru's related-note links in note frontmatter so Obsidian's graph
 * view draws the edges. Links are computed by the LLM-free sidecar linker
 * (semantic + lexical) and written via fileManager.processFrontMatter — which
 * touches only the uru-links property, never the body or other frontmatter, so
 * "Remove Uru links" is a clean, complete undo.
 */
export class GraphLinker {
	private ledger: LinkLedger;
	private running = false;
	private cancelRequested = false;

	constructor(
		private app: App,
		private client: () => SidecarClient | null,
		private settings: UruSettings,
		ledgerPath: string,
		private onStatus: (s: LinkStatus | null) => void = () => {},
	) {
		this.ledger = new LinkLedger(ledgerPath);
	}

	get isRunning(): boolean {
		return this.running;
	}
	linkedCount(): number {
		return this.ledger.count();
	}
	lastLinkedAt(): number | null {
		return this.ledger.linkedAt();
	}

	load(): void {
		this.ledger.load();
	}

	stop(): void {
		if (this.running) this.cancelRequested = true;
	}

	private eligibleFiles(): TFile[] {
		const ignore = this.settings.ignoreGlobs.map(globToRegExp);
		const isIgnored = (path: string) => !path.endsWith(".md") || ignore.some((re) => re.test(path));
		return this.app.vault.getMarkdownFiles().filter((f) => !isIgnored(f.path));
	}

	/** [[wikilink]] text for a target path, shortest unambiguous form, or null if gone. */
	private wikilinkFor(targetPath: string, sourcePath: string): string | null {
		const target = this.app.vault.getAbstractFileByPath(targetPath);
		if (!(target instanceof TFile)) return null;
		// fileToLinktext (not generateMarkdownLink) so we always emit [[wikilinks]] —
		// the only frontmatter form that produces graph edges — even in vaults set to
		// Markdown links. It also disambiguates duplicate basenames to a path.
		return `[[${this.app.metadataCache.fileToLinktext(target, sourcePath)}]]`;
	}

	private async setLinks(file: TFile, wikilinks: string[]): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			if (wikilinks.length) fm[URU_LINK_PROP] = wikilinks;
			else delete fm[URU_LINK_PROP];
		});
	}

	/**
	 * Compute links for the whole vault and write them into frontmatter. Idempotent:
	 * notes that had uru-links before but aren't linked now are cleared, so re-running
	 * never leaves stale edges. Returns true if it completed (false if stopped/failed).
	 */
	async link(): Promise<boolean> {
		const client = this.client();
		if (!client) {
			new Notice("Uru isn't ready yet — one moment…");
			return false;
		}
		if (this.running) {
			new Notice("Uru is already working on the graph");
			return false;
		}
		this.running = true;
		this.cancelRequested = false;
		try {
			const files = this.eligibleFiles();
			const byPath = new Map(files.map((f) => [f.path, f]));

			// ---- phase 1: compute (sidecar embeds + BM25) ----
			const startedAt = Date.now();
			this.onStatus({ phase: "compute", done: 0, total: files.length, current: "Analyzing notes…", startedAt });
			const docs: Array<{ external_id: string; content: string }> = [];
			for (const f of files) docs.push({ external_id: f.path, content: await this.app.vault.cachedRead(f) });
			if (docs.length < 2) {
				new Notice("Uru: need at least two notes to link.");
				return true;
			}
			const result = await client.computeLinks(docs, (completed, total) => {
				if (this.cancelRequested) return;
				this.onStatus({ phase: "compute", done: completed, total, current: "Analyzing notes…", startedAt });
			});
			if (this.cancelRequested) return false;

			// ---- phase 2: apply (union of new links + old ledger, so stale links clear) ----
			const toWrite = new Set<string>([...Object.keys(result.links), ...this.ledger.paths()]);
			const targets = [...toWrite].filter((p) => byPath.has(p));
			const linkedNow: string[] = [];
			let done = 0;
			let failed = 0;
			const appliedAt = Date.now();
			for (const path of targets) {
				if (this.cancelRequested) break;
				const file = byPath.get(path)!;
				this.onStatus({ phase: "apply", done, total: targets.length, current: file.basename, startedAt: appliedAt });
				const suggestions = result.links[path] ?? [];
				const wikilinks = suggestions
					.map((s) => this.wikilinkFor(s.target, path))
					.filter((w): w is string => w !== null);
				try {
					await this.setLinks(file, wikilinks);
					if (wikilinks.length) linkedNow.push(path);
				} catch (e) {
					failed++;
					console.warn(`[Uru] failed to write links into ${path}:`, e);
				}
				done++;
				if (done % 25 === 0) {
					this.ledger.set(linkedNow.slice(), appliedAt);
					this.ledger.save();
				}
			}
			this.ledger.set(linkedNow, appliedAt);
			this.ledger.save();

			const stopped = this.cancelRequested;
			new Notice(
				stopped
					? `Uru: stopped — linked ${linkedNow.length} notes so far.`
					: `Uru: linked ${linkedNow.length} notes in the graph` + (failed ? ` (${failed} failed)` : "."),
			);
			return !stopped;
		} catch (e) {
			new Notice(`Uru: linking failed — ${(e as Error).message}`);
			return false;
		} finally {
			this.running = false;
			this.cancelRequested = false;
			this.onStatus(null);
		}
	}

	/**
	 * Remove every Uru link. Strips the uru-links property from the ledgered notes
	 * PLUS any other note still carrying it (full-vault fallback), so undo is
	 * complete even if the ledger was lost. Never touches the body or other props.
	 */
	async unlink(): Promise<boolean> {
		if (this.running) {
			new Notice("Uru is already working on the graph");
			return false;
		}
		this.running = true;
		this.cancelRequested = false;
		try {
			// Union of the ledger and a live scan for the property (belt and suspenders).
			const paths = new Set<string>(this.ledger.paths());
			for (const f of this.app.vault.getMarkdownFiles()) {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
				if (fm && URU_LINK_PROP in fm) paths.add(f.path);
			}
			const targets = [...paths]
				.map((p) => this.app.vault.getAbstractFileByPath(p))
				.filter((f): f is TFile => f instanceof TFile);

			const startedAt = Date.now();
			let done = 0;
			let failed = 0;
			for (const file of targets) {
				if (this.cancelRequested) break;
				this.onStatus({ phase: "remove", done, total: targets.length, current: file.basename, startedAt });
				try {
					await this.setLinks(file, []);
				} catch (e) {
					failed++;
					console.warn(`[Uru] failed to remove links from ${file.path}:`, e);
				}
				done++;
			}
			// Clear the ledger only for what we actually got through, so a stop leaves
			// the remainder discoverable by the next unlink's full scan.
			this.ledger.set([], null);
			this.ledger.save();
			new Notice(
				this.cancelRequested
					? `Uru: stopped — removed links from ${done} notes.`
					: `Uru: removed links from ${done} notes` + (failed ? ` (${failed} failed)` : "."),
			);
			return !this.cancelRequested;
		} catch (e) {
			new Notice(`Uru: removing links failed — ${(e as Error).message}`);
			return false;
		} finally {
			this.running = false;
			this.cancelRequested = false;
			this.onStatus(null);
		}
	}
}
