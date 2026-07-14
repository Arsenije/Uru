import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type UruPlugin from "../../main";
import type { ChatCitation, ChatMessage, NoteContext } from "../sidecar/client";
import { etaSeconds, formatEta, type IndexStatus } from "../indexing/indexer";

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
	private unsubStatus: (() => void) | null = null;
	private emptyEl: HTMLElement | null = null;
	private progressFill: HTMLElement | null = null;
	private progressLabel: HTMLElement | null = null;
	private lastStatus: IndexStatus | null = null;
	/** Which gate box is currently rendered — dedupes rebuilds on repeated boot ticks. */
	private gateMode: "loading" | "error" | "index-empty" | "index-progress" | null = null;

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
		// Boot gate: while the backend is coming up (or failed), show a loading/
		// error state instead of the index prompt. Also fires immediately.
		this.unsubStatus = this.plugin.onBackendStatus(() => this.refreshGate());
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
		this.refreshGate();
	}

	/**
	 * Single coordinator for what the message area shows. Boot state wins over the
	 * index gate: while the backend isn't fully up (or failed) we show a loading/
	 * error box; once ready we fall through to the index gate on the last status.
	 */
	private refreshGate(): void {
		if (this.plugin.settings.installed && this.plugin.backendState === "error") {
			this.renderErrorState(this.plugin.statusDetailText);
			return;
		}
		if (this.plugin.settings.installed && !this.plugin.backendReady()) {
			this.renderStartingState();
			return;
		}
		this.applyIndexGate(this.lastStatus);
	}

	private applyIndexGate(status: IndexStatus | null): void {
		if (status === null) {
			// Indexing idle. If the vault now has content, lift the gate;
			// otherwise (never indexed, or stopped before any note) show the prompt.
			if (!this.unindexed) {
				this.clearGate();
				return;
			}
			// The heartbeat re-emits "ok" every 15s — don't tear down and rebuild
			// an identical prompt (visible flicker), and never resurrect the
			// index button after a click already swapped it for the progress bar.
			if (this.gateMode === "index-empty") return;
			this.gateMode = "index-empty";
			this.renderEmptyState(null);
			return;
		}
		this.gateMode = "index-progress";
		// In-progress tick: update the bar in place if it's showing, else render it.
		if (this.progressFill && this.progressLabel) {
			this.updateProgress(status);
		} else {
			this.renderEmptyState(status);
		}
	}

	private setComposerEnabled(
		enabled: boolean,
		disabledPlaceholder = "Index your vault to start chatting…",
	): void {
		this.input.disabled = !enabled;
		this.sendBtn.disabled = !enabled;
		this.input.placeholder = enabled
			? "Ask your vault… (Enter to send, Shift+Enter for newline)"
			: disabledPlaceholder;
	}

	/** Remove the empty-state prompt and re-enable the composer. */
	private clearGate(): void {
		this.gateMode = null;
		this.emptyEl?.remove();
		this.emptyEl = null;
		this.progressFill = this.progressLabel = null;
		this.setComposerEnabled(true);
	}

	/** Backend still booting — show a loading box with an indeterminate bar. */
	private renderStartingState(): void {
		if (this.gateMode === "loading") return; // already showing — don't restart the animation
		this.gateMode = "loading";
		this.setComposerEnabled(false, "Uru is starting up…");
		this.messagesEl.empty();
		this.progressFill = this.progressLabel = null;
		const box = this.messagesEl.createDiv({ cls: "uru-empty" });
		this.emptyEl = box;
		box.createEl("div", { cls: "uru-empty-title", text: "Uru is starting up…" });
		box.createEl("p", {
			cls: "uru-empty-copy",
			text: "Uru is starting up — this can take a moment on first launch.",
		});
		const action = box.createDiv({ cls: "uru-empty-action" });
		this.renderProgress(action, null); // indeterminate "Starting…" bar
	}

	/** Backend failed to start — show the error and a Retry button. */
	private renderErrorState(detail: string): void {
		if (this.gateMode === "error") return;
		this.gateMode = "error";
		this.setComposerEnabled(false, "Uru couldn't start");
		this.messagesEl.empty();
		this.progressFill = this.progressLabel = null;
		const box = this.messagesEl.createDiv({ cls: "uru-empty" });
		this.emptyEl = box;
		box.createEl("div", { cls: "uru-empty-title", text: "Uru couldn't start" });
		box.createEl("p", {
			cls: "uru-empty-copy",
			text: detail || "Uru couldn't start. Give it another try or check the settings.",
		});
		const action = box.createDiv({ cls: "uru-empty-action" });
		action
			.createEl("button", { cls: "mod-cta uru-empty-btn", text: "Retry" })
			.addEventListener("click", () => void this.plugin.restartBackend());
	}

	/** Show the first-run prompt (copy + button), or a progress bar while indexing. */
	private renderEmptyState(status: IndexStatus | null): void {
		this.setComposerEnabled(false);
		this.messagesEl.empty();
		this.progressFill = this.progressLabel = null;
		// A prior run stopped/crashed before the first note completed (count still 0).
		const interrupted =
			status === null && !this.plugin.isIndexing() && this.plugin.settings.indexInterrupted;
		const box = this.messagesEl.createDiv({ cls: "uru-empty" });
		this.emptyEl = box;
		box.createEl("div", { cls: "uru-empty-title", text: "Chat with your vault" });
		box.createEl("p", {
			cls: "uru-empty-copy",
			text: interrupted
				? "Indexing didn't finish last time. Resume to pick up where it left off — " +
					"you can keep working while it runs."
				: "Uru reads your notes before it can answer. Indexing runs once, on your " +
					"machine — a few minutes for a large vault. You can keep working while it runs.",
		});
		const action = box.createDiv({ cls: "uru-empty-action" });
		if (status !== null || this.plugin.isIndexing()) {
			this.renderProgress(action, status);
		} else {
			const btn = action.createEl("button", {
				cls: "mod-cta uru-empty-btn",
				text: interrupted ? "Resume indexing" : "Index my vault",
			});
			btn.addEventListener("click", () => {
				if (!this.plugin.backendReady()) {
					new Notice("Uru is still starting — one moment…");
					return;
				}
				this.renderProgress(action, null); // button → bar immediately
				void this.plugin.reindex(false);
			});
		}
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
		this.progressFill.style.setProperty("--uru-progress", `${pct}%`);
		const eta = etaSeconds(status);
		const suffix = eta !== null ? ` · ${formatEta(eta)}` : "…";
		this.progressLabel.setText(`Indexing ${status.done}/${status.total}${suffix}`);
	}

	private reset(): void {
		this.history = [];
		this.messagesEl.empty();
		this.emptyEl = null;
		this.progressFill = this.progressLabel = null;
		this.gateMode = null;
		// Re-evaluate: loading/error while booting, index prompt if unindexed, else clear.
		this.refreshGate();
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
			new Notice("Uru is still starting — one moment…");
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
			await MarkdownRenderer.render(this.plugin.app, answer || "No answer — try rephrasing.", answerEl, "", this);
			this.renderCitations(answerEl, citations);

			this.history.push({ role: "user", content: query });
			this.history.push({ role: "assistant", content: answer });
		} catch (e) {
			answerEl.setText(`Couldn't get an answer — ${(e as Error).message}`);
		} finally {
			this.busy = false;
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}

	async onClose(): Promise<void> {
		this.unsubIndex?.();
		this.unsubIndex = null;
		this.unsubStatus?.();
		this.unsubStatus = null;
		this.contentEl.empty();
	}
}
