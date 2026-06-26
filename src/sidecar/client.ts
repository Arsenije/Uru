import { requestUrl } from "obsidian";

// Wire shapes — mirror sidecar/uru_sidecar/serialize.py.
export interface HealthResponse {
	status: "starting" | "ok" | "error" | "stopping" | "disconnected";
	error: string | null;
	namespace_id: string | null;
	backend: string;
	extract_entities: boolean;
	models: { chat: string; embed: string };
	khora: Record<string, unknown>;
}

export interface RecallChunk {
	document_id: string;
	content: string;
	score: number;
}

export interface RecallDocument {
	id: string;
	external_id: string | null;
	title: string | null;
	source_type: string;
}

export interface RecallEntity {
	name: string;
	entity_type: string;
	score: number;
	source_document_ids: string[];
}

export interface RecallRelationship {
	source: string | null;
	target: string | null;
	type: string | null;
	score: number | null;
	source_document_ids: string[];
}

export interface RecallResult {
	namespace_id: string;
	chunks: RecallChunk[];
	documents: RecallDocument[];
	entities: RecallEntity[];
	relationships: RecallRelationship[];
	engine_info: Record<string, unknown>;
}

export interface RememberResult {
	document_id: string;
	namespace_id: string;
	chunks_created: number;
	entities_extracted: number;
	relationships_created: number;
	relationships_skipped: number;
}

export interface BatchResult {
	total: number;
	processed: number;
	skipped: number;
	failed: number;
	chunks: number;
	entities: number;
	relationships: number;
}

export interface BatchDocument {
	external_id: string;
	content: string;
	title?: string;
	metadata?: Record<string, unknown>;
}

/** Typed HTTP client for the Uru sidecar control API. */
export class SidecarClient {
	constructor(
		private baseUrl: string,
		private token: string,
	) {}

	private get authHeader(): Record<string, string> {
		return { Authorization: `Bearer ${this.token}` };
	}

	/** Unauthenticated readiness probe; returns null if unreachable. */
	async health(): Promise<HealthResponse | null> {
		try {
			const r = await requestUrl({ url: `${this.baseUrl}/health`, method: "GET", throw: false });
			if (r.status !== 200) return null;
			return r.json as HealthResponse;
		} catch {
			return null;
		}
	}

	async recall(query: string, opts: { limit?: number; minSimilarity?: number } = {}): Promise<RecallResult> {
		return this.post<RecallResult>("/recall", {
			query,
			limit: opts.limit ?? 10,
			min_similarity: opts.minSimilarity ?? 0.0,
		});
	}

	async remember(doc: BatchDocument): Promise<RememberResult> {
		return this.post<RememberResult>("/remember", {
			external_id: doc.external_id,
			content: doc.content,
			title: doc.title ?? "",
			metadata: doc.metadata ?? {},
		});
	}

	async forget(externalId: string): Promise<{ deleted: boolean }> {
		return this.post("/forget", { external_id: externalId });
	}

	async shutdown(): Promise<void> {
		try {
			await this.post("/shutdown", {});
		} catch {
			/* the process is exiting; a dropped connection is expected */
		}
	}

	private async post<T>(path: string, body: unknown): Promise<T> {
		const r = await requestUrl({
			url: `${this.baseUrl}${path}`,
			method: "POST",
			headers: { "content-type": "application/json", ...this.authHeader },
			body: JSON.stringify(body),
			throw: false,
		});
		if (r.status < 200 || r.status >= 300) {
			throw new Error(`${path} failed: HTTP ${r.status} ${r.text ?? ""}`);
		}
		return r.json as T;
	}
}
