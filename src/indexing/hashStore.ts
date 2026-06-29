import type { DataAdapter } from "obsidian";

export interface IndexEntry {
	hash: string;
	docId: string;
	lastIndexed: number;
}

/**
 * Persists `{ vault-relative path -> {hash, docId, lastIndexed} }` so the
 * indexer can skip unchanged notes (avoiding the per-note LLM extraction cost)
 * and resolve a path to its khora document id for fast deletes.
 *
 * Kept in its own file (not data.json) so the settings blob stays small.
 */
export class HashStore {
	private entries: Record<string, IndexEntry> = {};
	private loaded = false;

	constructor(
		private adapter: DataAdapter,
		private path: string,
	) {}

	async load(): Promise<void> {
		try {
			if (await this.adapter.exists(this.path)) {
				this.entries = JSON.parse(await this.adapter.read(this.path));
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
		await this.adapter.write(this.path, JSON.stringify(this.entries));
	}
}
