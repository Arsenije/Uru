import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import type UruPlugin from "../../main";
import type { RecallResult } from "../sidecar/client";

export const URU_RECALL_VIEW = "uru-recall-view";

export class RecallView extends ItemView {
	private input!: HTMLInputElement;
	private resultsEl!: HTMLElement;

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
		return "Uru recall";
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
		bar.createEl("button", { text: "Recall" }).addEventListener("click", () => void this.run());

		this.resultsEl = root.createDiv({ cls: "uru-recall-results" });
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
			new Notice("Uru backend not ready");
			return;
		}
		this.resultsEl.empty();
		this.resultsEl.createDiv({ cls: "uru-recall-status", text: "Searching…" });
		try {
			const result = await client.recall(query, { limit: 20 });
			this.render(result);
		} catch (e) {
			this.resultsEl.empty();
			this.resultsEl.createDiv({ cls: "uru-recall-status", text: `Error: ${(e as Error).message}` });
		}
	}

	private render(result: RecallResult): void {
		this.resultsEl.empty();

		if (result.entities.length) {
			const ent = this.resultsEl.createDiv({ cls: "uru-recall-entities" });
			ent.createEl("div", { cls: "uru-recall-section", text: "Entities" });
			const chips = ent.createDiv({ cls: "uru-recall-chips" });
			for (const e of result.entities.slice(0, 12)) {
				chips.createEl("span", {
					cls: "uru-recall-chip",
					text: `${e.name} · ${e.entity_type.toLowerCase()}`,
				});
			}
		}

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
			head.createEl("span", { cls: "uru-recall-score", text: group.score.toFixed(2) });
			link.addEventListener("click", () => {
				void this.plugin.app.workspace.openLinkText(path, "", false);
			});
			item.createDiv({ cls: "uru-recall-snippet", text: group.snippets[0] });
		}
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
