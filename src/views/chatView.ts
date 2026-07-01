import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type UruPlugin from "../../main";
import type { ChatCitation, ChatMessage, NoteContext } from "../sidecar/client";
import type { IndexStatus } from "../indexing/indexer";

export const URU_CHAT_VIEW = "uru-chat-view";

type ChatScope = "vault" | "note";

export class ChatView extends ItemView {
	private messagesEl!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private history: ChatMessage[] = [];
	private busy = false;
	private chatScope: ChatScope = "vault";
	private unsubIndex: (() => void) | null = null;
	private emptyEl: HTMLElement | null = null;
	private progressFill: HTMLElement | null = null;
	private progressLabel: HTMLElement | null = null;
	private lastStatus: IndexStatus | null = null;
	/** First-run Deep/Quick pick; null until chosen (falls back to the setting). */
	private chosenDeep: boolean | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: UruPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return URU_CHAT_VIEW;
	}
	getDisplayText(): string {
		return "Uru chat";
	}
	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("uru-chat");

		const header = root.createDiv({ cls: "uru-chat-header" });
		// Scope switch — Vault (default) vs Current note.
		const scopeBar = header.createDiv({ cls: "uru-chat-scope" });
		const vaultBtn = scopeBar.createEl("button", { text: "Vault", cls: "uru-scope-btn is-active" });
		const noteBtn = scopeBar.createEl("button", { text: "Current note", cls: "uru-scope-btn" });
		const setScope = (s: ChatScope) => {
			this.chatScope = s;
			vaultBtn.toggleClass("is-active", s === "vault");
			noteBtn.toggleClass("is-active", s === "note");
		};
		vaultBtn.addEventListener("click", () => setScope("vault"));
		noteBtn.addEventListener("click", () => setScope("note"));

		header.createEl("button", { text: "New chat", cls: "uru-chat-new" }).addEventListener(
			"click",
			() => this.reset(),
		);

		this.messagesEl = root.createDiv({ cls: "uru-chat-messages" });

		const bar = root.createDiv({ cls: "uru-chat-bar" });
		this.input = bar.createEl("textarea", {
			cls: "uru-chat-input",
			attr: { placeholder: "Ask your vault… (Enter to send, Shift+Enter for newline)", rows: "2" },
		});
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.send();
			}
		});
		this.sendBtn = bar.createEl("button", { text: "Send", cls: "mod-cta" });
		this.sendBtn.addEventListener("click", () => void this.send());

		// First-run gate: mirror the indexer's progress so an unindexed vault
		// shows an "index your vault" prompt instead of a dead chat box. The
		// callback fires immediately with the current status on subscribe.
		this.unsubIndex = this.plugin.onIndexStatus((s) => this.onIndexStatusUpdate(s));
	}

	focusInput(): void {
		this.input?.focus();
	}

	/** No notes tracked yet — chat can't answer until the vault is indexed. */
	private get unindexed(): boolean {
		return this.plugin.indexedCount() === 0;
	}

	private onIndexStatusUpdate(status: IndexStatus | null): void {
		this.lastStatus = status;
		if (status === null) {
			// Indexing idle. If the vault now has content, lift the gate;
			// otherwise (never indexed, or stopped before any note) show the prompt.
			if (this.unindexed) this.renderEmptyState(null);
			else this.clearGate();
			return;
		}
		// In-progress tick: update the bar in place if it's showing, else render it.
		if (this.progressFill && this.progressLabel) {
			this.updateProgress(status);
		} else {
			this.renderEmptyState(status);
		}
	}

	private setComposerEnabled(enabled: boolean): void {
		this.input.disabled = !enabled;
		this.sendBtn.disabled = !enabled;
		this.input.placeholder = enabled
			? "Ask your vault… (Enter to send, Shift+Enter for newline)"
			: "Index your vault to start chatting…";
	}

	/** Remove the empty-state prompt and re-enable the composer. */
	private clearGate(): void {
		this.emptyEl?.remove();
		this.emptyEl = null;
		this.progressFill = this.progressLabel = null;
		this.setComposerEnabled(true);
	}

	/** Show the first-run prompt (copy + button), or a progress bar while indexing. */
	private renderEmptyState(status: IndexStatus | null): void {
		this.setComposerEnabled(false);
		this.messagesEl.empty();
		this.progressFill = this.progressLabel = null;
		const box = this.messagesEl.createDiv({ cls: "uru-empty" });
		this.emptyEl = box;
		box.createEl("div", { cls: "uru-empty-title", text: "Chat with your vault" });
		box.createEl("p", {
			cls: "uru-empty-copy",
			text:
				"Uru reads your notes before it can answer. Indexing runs once, on your " +
				"machine — a few minutes for a large vault. You can keep working while it runs.",
		});
		const action = box.createDiv({ cls: "uru-empty-action" });
		if (status !== null || this.plugin.isIndexing()) {
			this.renderProgress(action, status);
		} else {
			this.renderModeChoice(action);
			const btn = action.createEl("button", { cls: "mod-cta uru-empty-btn", text: "Index my vault" });
			btn.addEventListener("click", async () => {
				if (!this.plugin.backendReady()) {
					new Notice("Uru is still starting — one moment…");
					return;
				}
				const deep = this.chosenDeep ?? this.plugin.settings.extractEntities;
				this.renderProgress(action, null); // button → bar immediately
				try {
					// Apply the pick first (restarts the backend only if it differs),
					// so the very first index runs in the chosen mode.
					await this.plugin.applyIndexingMode(deep);
					void this.plugin.reindex(false);
				} catch (e) {
					new Notice(`Uru: ${(e as Error).message}`);
					this.renderEmptyState(null); // restore the chooser + button
				}
			});
		}
	}

	/** Deep vs Quick chooser for first-timers — mirrors the setup dialog's copy. */
	private renderModeChoice(parent: HTMLElement): void {
		const selected = this.chosenDeep ?? this.plugin.settings.extractEntities;
		this.chosenDeep = selected;
		const opts = [
			{
				deep: false,
				label: "Quick",
				desc: "Find notes by meaning, not just keywords. Fast to set up.",
			},
			{
				deep: true,
				label: "Deep",
				desc:
					"Everything Quick does, plus a map of the people, places, and ideas across " +
					"your notes and how they connect. More powerful, but slower to build " +
					"(~5–30 seconds per note the first time).",
			},
		];
		const wrap = parent.createDiv({ cls: "uru-choice" });
		const cards: HTMLElement[] = [];
		for (const o of opts) {
			const card = wrap.createDiv({ cls: "uru-choice-opt" });
			const radio = card.createEl("input", {
				attr: { type: "radio", name: "uru-mode" },
			}) as HTMLInputElement;
			const text = card.createDiv();
			text.createDiv({ cls: "uru-choice-label", text: o.label });
			text.createDiv({ cls: "uru-choice-desc", text: o.desc });
			card.addEventListener("click", () => {
				this.chosenDeep = o.deep;
				cards.forEach((c, i) => {
					const on = opts[i].deep === o.deep;
					c.toggleClass("is-selected", on);
					(c.querySelector("input") as HTMLInputElement).checked = on;
				});
			});
			radio.checked = o.deep === selected;
			card.toggleClass("is-selected", o.deep === selected);
			cards.push(card);
		}
		parent.createEl("p", {
			cls: "uru-choice-note",
			text: "You can switch anytime in Uru's settings.",
		});
	}

	private renderProgress(parent: HTMLElement, status: IndexStatus | null): void {
		parent.empty();
		const wrap = parent.createDiv({ cls: "uru-progress" });
		const track = wrap.createDiv({ cls: "uru-progress-track" });
		this.progressFill = track.createDiv({ cls: "uru-progress-fill" });
		this.progressLabel = wrap.createDiv({ cls: "uru-progress-label" });
		if (status) {
			this.updateProgress(status);
		} else {
			track.addClass("is-indeterminate");
			this.progressLabel.setText("Starting…");
		}
	}

	private updateProgress(status: IndexStatus): void {
		if (!this.progressFill || !this.progressLabel) return;
		this.progressFill.parentElement?.removeClass("is-indeterminate");
		const pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
		this.progressFill.style.width = `${pct}%`;
		this.progressLabel.setText(`Indexing ${status.done}/${status.total}…`);
	}

	private reset(): void {
		this.history = [];
		this.messagesEl.empty();
		this.emptyEl = null;
		this.progressFill = this.progressLabel = null;
		if (this.unindexed) this.renderEmptyState(this.lastStatus);
	}

	private addBubble(role: "user" | "assistant"): HTMLElement {
		const wrap = this.messagesEl.createDiv({ cls: `uru-chat-msg uru-chat-${role}` });
		const body = wrap.createDiv({ cls: "uru-chat-body" });
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		return body;
	}

	private renderCitations(parent: HTMLElement, citations: ChatCitation[]): void {
		if (!citations.length) return;
		const box = parent.createDiv({ cls: "uru-chat-sources" });
		box.createEl("div", { cls: "uru-recall-section", text: "Sources" });
		for (const c of citations) {
			const link = box.createEl("a", { cls: "uru-chat-cite", text: `[${c.index}] ${c.title}` });
			link.addEventListener("click", () =>
				void this.plugin.app.workspace.openLinkText(c.external_id, "", false),
			);
		}
	}

	private async send(): Promise<void> {
		const query = this.input.value.trim();
		if (!query || this.busy || this.input.disabled) return;
		const client = this.plugin.client();
		if (!client) {
			new Notice("Uru backend not ready");
			return;
		}

		// 'Current note' scope: feed the active note's text as context.
		let note: NoteContext | undefined;
		if (this.chatScope === "note") {
			const file = this.plugin.app.workspace.getActiveFile();
			if (!file) {
				new Notice("Open a note to chat about it");
				return;
			}
			const content = await this.plugin.app.vault.cachedRead(file);
			note = { external_id: file.path, title: file.basename, content };
		}

		this.busy = true;
		this.input.value = "";

		this.addBubble("user").setText(query);
		const answerEl = this.addBubble("assistant");
		answerEl.setText("…");
		const historySnapshot = [...this.history];

		let answer = "";
		let citations: ChatCitation[] = [];
		try {
			// Prefer streaming; fall back to a single non-streaming call if the
			// renderer blocks fetch streaming.
			try {
				for await (const ev of client.chatStream(query, historySnapshot, note)) {
					if (ev.event === "sources") {
						citations = ev.citations;
					} else if (ev.event === "token") {
						answer += ev.text;
						answerEl.setText(answer);
						this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
					}
				}
			} catch {
				const res = await client.chatSync(query, historySnapshot, note);
				answer = res.answer;
				citations = res.citations;
			}

			// Final render: markdown body + clickable sources.
			answerEl.empty();
			await MarkdownRenderer.render(this.plugin.app, answer || "(no answer)", answerEl, "", this);
			this.renderCitations(answerEl, citations);

			this.history.push({ role: "user", content: query });
			this.history.push({ role: "assistant", content: answer });
		} catch (e) {
			answerEl.setText(`Error: ${(e as Error).message}`);
		} finally {
			this.busy = false;
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}

	async onClose(): Promise<void> {
		this.unsubIndex?.();
		this.unsubIndex = null;
		this.contentEl.empty();
	}
}
