import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type UruPlugin from "../../main";
import type { ChatCitation, ChatMessage } from "../sidecar/client";

export const URU_CHAT_VIEW = "uru-chat-view";

export class ChatView extends ItemView {
	private messagesEl!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private history: ChatMessage[] = [];
	private busy = false;

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
		header.createEl("span", { text: "Chat with your vault" });
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
		bar.createEl("button", { text: "Send", cls: "mod-cta" }).addEventListener("click", () => void this.send());
	}

	focusInput(): void {
		this.input?.focus();
	}

	private reset(): void {
		this.history = [];
		this.messagesEl.empty();
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
		if (!query || this.busy) return;
		const client = this.plugin.client();
		if (!client) {
			new Notice("Uru backend not ready");
			return;
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
				for await (const ev of client.chatStream(query, historySnapshot)) {
					if (ev.event === "sources") {
						citations = ev.citations;
					} else if (ev.event === "token") {
						answer += ev.text;
						answerEl.setText(answer);
						this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
					}
				}
			} catch {
				const res = await client.chatSync(query, historySnapshot);
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
		this.contentEl.empty();
	}
}
