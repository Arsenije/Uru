import { requestUrl } from "obsidian";

// Wire shapes — mirror sidecar/uru_sidecar/serialize.py.
export interface HealthResponse {
	status: "starting" | "ok" | "error" | "stopping" | "disconnected";
	error: string | null;
	namespace_id: string | null;
	backend: string;
	models: { chat: string; embed: string };
	/** Live liveness of the two llama children; absent on older sidecars. */
	inference?: { chat: boolean; embed: boolean };
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

export interface RecallResult {
	namespace_id: string;
	chunks: RecallChunk[];
	documents: RecallDocument[];
	engine_info: Record<string, unknown>;
}

export interface RememberResult {
	document_id: string;
	namespace_id: string;
	chunks_created: number;
}

export interface BatchResult {
	total: number;
	processed: number;
	skipped: number;
	failed: number;
	chunks: number;
}

export interface BatchDocument {
	external_id: string;
	content: string;
	title?: string;
	metadata?: Record<string, unknown>;
}

export interface ChatCitation {
	index: number;
	external_id: string;
	title: string;
}

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

/** Explicit context for 'current note' chat scope. */
export interface NoteContext {
	external_id: string;
	title: string;
	content: string;
}

export type ChatEvent =
	| { event: "sources"; citations: ChatCitation[] }
	| { event: "token"; text: string }
	| { event: "done" };

export interface ChatResult {
	answer: string;
	citations: ChatCitation[];
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

	/**
	 * Chat (RAG). Yields sources, then answer tokens, in order.
	 *
	 * Obsidian requires requestUrl over fetch for network requests. requestUrl
	 * buffers the whole response before returning, so we still hit the streaming
	 * endpoint but the sidecar's NDJSON events arrive together rather than
	 * token-by-token — callers keep their event-driven handling, the answer just
	 * materializes at once. chatSync() remains a fallback if this call throws.
	 */
	async *chatStream(
		query: string,
		history: ChatMessage[],
		note?: NoteContext,
	): AsyncGenerator<ChatEvent> {
		const r = await requestUrl({
			url: `${this.baseUrl}/chat`,
			method: "POST",
			headers: { "content-type": "application/json", ...this.authHeader },
			body: JSON.stringify({ query, history, stream: true, note }),
			throw: false,
		});
		if (r.status < 200 || r.status >= 300) {
			throw new Error(`chat failed: HTTP ${r.status} ${r.text ?? ""}`);
		}
		for (const line of r.text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed) yield JSON.parse(trimmed) as ChatEvent;
		}
	}

	/** Non-streaming chat via requestUrl (fallback when chatStream throws). */
	async chatSync(query: string, history: ChatMessage[], note?: NoteContext): Promise<ChatResult> {
		return this.post<ChatResult>("/chat", { query, history, stream: false, note });
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
