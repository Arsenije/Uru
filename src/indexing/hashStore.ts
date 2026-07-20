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

export interface IndexEntry {
	hash: string;
	docId: string;
	lastIndexed: number;
}

/**
 * Persists `{ vault-relative path -> {hash, docId, lastIndexed} }` so the
 * indexer can skip unchanged notes and resolve a path to its khora document id
 * for fast deletes.
 *
 * Stored at an absolute app-data path (outside the vault) so it survives plugin
 * updates alongside the khora db — hence node `fs`, not Obsidian's DataAdapter.
 */
export class HashStore {
	private entries: Record<string, IndexEntry> = {};
	private loaded = false;

	constructor(private path: string) {}

	async load(): Promise<void> {
		// Try the committed file first, then a leftover temp (a crash between
		// fsync and rename can leave the new state only in `.tmp`). Reset to empty
		// only if neither parses — this is the sole path that forces a full
		// re-index, so the atomic save() below makes it near-impossible.
		const tmp = `${this.path}.tmp`;
		this.entries = this.readIfValid(this.path) ?? this.readIfValid(tmp) ?? {};
		if (existsSync(tmp)) {
			try {
				unlinkSync(tmp);
			} catch {
				/* best-effort cleanup */
			}
		}
		this.loaded = true;
	}

	private readIfValid(path: string): Record<string, IndexEntry> | null {
		try {
			if (!existsSync(path)) return null;
			return JSON.parse(readFileSync(path, "utf8")) as Record<string, IndexEntry>;
		} catch {
			return null;
		}
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
		// Atomic write: fill a temp file, fsync it durably, then rename over the
		// target. A crash/power-loss yields either the old or the new complete
		// file — never a torn one that would reset the index to empty.
		const tmp = `${this.path}.tmp`;
		const fd = openSync(tmp, "w");
		try {
			writeSync(fd, JSON.stringify(this.entries));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, this.path);
	}
}
