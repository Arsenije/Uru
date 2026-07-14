import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import type UruPlugin from "../../main";
import type { RecallResult } from "../sidecar/client";

export const URU_RECALL_VIEW = "uru-recall-view";

export class RecallView extends ItemView {
	private input!: HTMLInputElement;
	private resultsEl!: HTMLElement;
	private unsubStatus: (() => void) | null = null;
	/** Which boot banner is showing — dedupes rebuilds on repeated boot ticks. */
	private gateMode: "loading" | "error" | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: UruPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return URU_RECALL_VIEW;
	}
	getDisplayText(): string {
		return "Uru search";
	}
	getIcon(): string {
		return "search";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("uru-recall");

		const bar = root.createDiv({ cls: "uru-recall-bar" });
		this.input = bar.createEl("input", {
			type: "text",
			placeholder: "Ask your vault…",
			cls: "uru-recall-input",
		});
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") void this.run();
		});
		bar.createEl("button", { text: "Search" }).addEventListener("click", () => void this.run());

		this.resultsEl = root.createDiv({ cls: "uru-recall-results" });

		// Boot gate: while the backend is coming up (or failed), disable the box
		// and show a loading/error banner. Fires immediately on subscribe.
		this.unsubStatus = this.plugin.onBackendStatus(() => this.refreshGate());
	}

	/**
	 * While the backend isn't fully up (or failed), disable the search box and show
	 * a boot banner; once ready, re-enable it and clear only the banner (not results).
	 */
	private refreshGate(): void {
		const installed = this.plugin.settings.installed;
		if (installed && this.plugin.backendState === "error") {
			if (this.gateMode === "error") return;
			this.gateMode = "error";
			this.input.disabled = true;
			this.input.placeholder = "Uru couldn't start";
			this.resultsEl.empty();
			const box = this.resultsEl.createDiv({ cls: "uru-recall-status" });
			box.setText(
				this.plugin.statusDetailText ||
					"Uru couldn't start. Give it another try or check the settings.",
			);
			box
				.createEl("button", { cls: "mod-cta", text: "Retry" })
				.addEventListener("click", () => void this.plugin.restartBackend());
			return;
		}
		if (installed && !this.plugin.backendReady()) {
			if (this.gateMode === "loading") return;
			this.gateMode = "loading";
			this.input.disabled = true;
			this.input.placeholder = "Uru is starting up…";
			this.resultsEl.empty();
			this.resultsEl.createDiv({ cls: "uru-recall-status", text: "Uru is starting up…" });
			return;
		}
		// Ready: re-enable the box. Clear the banner if one was showing, but leave
		// any live results untouched.
		this.input.disabled = false;
		this.input.placeholder = "Ask your vault…";
		if (this.gateMode !== null) this.resultsEl.empty();
		this.gateMode = null;
	}

	/** Focus and optionally seed the query box (used by the command). */
	focusInput(query?: string): void {
		if (query !== undefined) this.input.value = query;
		this.input.focus();
		this.input.select();
	}

	private async run(): Promise<void> {
		const query = this.input.value.trim();
		if (!query) return;
		const client = this.plugin.client();
		if (!client) {
			new Notice("Uru is still starting — one moment…");
			return;
		}
		this.resultsEl.empty();
		this.resultsEl.createDiv({ cls: "uru-recall-status", text: "Searching…" });
		try {
			const result = await client.recall(query, { limit: 20 });
			this.render(result);
		} catch (e) {
			this.resultsEl.empty();
			this.resultsEl.createDiv({ cls: "uru-recall-status", text: `Couldn't search — ${(e as Error).message}` });
		}
	}

	private render(result: RecallResult): void {
		this.resultsEl.empty();

		// Group chunks by their source note (external_id).
		const byDoc = new Map<string, { title: string; score: number; snippets: string[] }>();
		const docById = new Map(result.documents.map((d) => [d.id, d]));
		for (const c of result.chunks) {
			const doc = docById.get(c.document_id);
			const key = doc?.external_id ?? c.document_id;
			const group = byDoc.get(key) ?? {
				title: doc?.title ?? key,
				score: 0,
				snippets: [],
			};
			group.score = Math.max(group.score, c.score);
			group.snippets.push(c.content.trim().slice(0, 240));
			byDoc.set(key, group);
		}

		if (byDoc.size === 0) {
			this.resultsEl.createDiv({ cls: "uru-recall-status", text: "No results." });
			return;
		}

		const sorted = [...byDoc.entries()].sort((a, b) => b[1].score - a[1].score);
		const list = this.resultsEl.createDiv({ cls: "uru-recall-list" });
		for (const [path, group] of sorted) {
			const item = list.createDiv({ cls: "uru-recall-item" });
			const head = item.createDiv({ cls: "uru-recall-item-head" });
			const link = head.createEl("a", { cls: "uru-recall-title", text: group.title });
			link.addEventListener("click", () => {
				void this.plugin.app.workspace.openLinkText(path, "", false);
			});
			item.createDiv({ cls: "uru-recall-snippet", text: group.snippets[0] });
		}
	}

	async onClose(): Promise<void> {
		this.unsubStatus?.();
		this.unsubStatus = null;
		this.contentEl.empty();
	}
}
