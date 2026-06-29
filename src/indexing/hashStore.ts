import { existsSync, readFileSync, writeFileSync } from "fs";

export interface IndexEntry {
	hash: string;
	docId: string;
	lastIndexed: number;
	/**
	 * Extraction mode the note was last indexed under (true = full KG, false =
	 * embeddings-only). Undefined on entries written before this was tracked.
	 * Drives forced re-extraction when the user toggles Lite ↔ Full.
	 */
	extractEntities?: boolean;
}

/**
 * Persists `{ vault-relative path -> {hash, docId, lastIndexed} }` so the
 * indexer can skip unchanged notes (avoiding per-note LLM extraction cost) and
 * resolve a path to its khora document id for fast deletes.
 *
 * Stored at an absolute app-data path (outside the vault) so it survives plugin
 * updates alongside the khora db — hence node `fs`, not Obsidian's DataAdapter.
 */
export class HashStore {
	private entries: Record<string, IndexEntry> = {};
	private loaded = false;

	constructor(private path: string) {}

	async load(): Promise<void> {
		try {
			if (existsSync(this.path)) {
				this.entries = JSON.parse(readFileSync(this.path, "utf8"));
			}
		} catch {
			this.entries = {};
		}
		this.loaded = true;
	}

	get(externalId: string): IndexEntry | undefined {
		return this.entries[externalId];
	}

	isUnchanged(externalId: string, hash: string): boolean {
		return this.entries[externalId]?.hash === hash;
	}

	set(externalId: string, entry: IndexEntry): void {
		this.entries[externalId] = entry;
	}

	delete(externalId: string): void {
		delete this.entries[externalId];
	}

	/** All tracked paths — used to detect notes deleted while the plugin was off. */
	knownPaths(): string[] {
		return Object.keys(this.entries);
	}

	/** Number of notes currently tracked as indexed. */
	count(): number {
		return Object.keys(this.entries).length;
	}

	async save(): Promise<void> {
		if (!this.loaded) return;
		writeFileSync(this.path, JSON.stringify(this.entries));
	}
}
