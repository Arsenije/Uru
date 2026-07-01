import { App, ButtonComponent, PluginSettingTab, Setting, Notice } from "obsidian";
import type UruPlugin from "../main";
import { etaSeconds, formatEta, type IndexStatus } from "./indexing/indexer";

export interface UruSettings {
	/** Set after bootstrap: interpreter inside the uv venv. */
	pythonPath: string;
	/** Sidecar working dir (the uru_sidecar package root). */
	sidecarCwd: string;
	installed: boolean;

	// Models (the embedding model fixes the vector dimension permanently).
	chatModelPath: string;
	embedModelPath: string;
	embeddingDimension: number;

	// Namespace, scoped per vault.
	vaultKey: string;
	namespaceId: string | null;

	// Indexing behaviour.
	extractEntities: boolean; // full KG vs. embeddings-only "lite"
	ignoreGlobs: string[];
	includeFrontmatter: boolean;
	autoIndexOnStartup: boolean;
	/** Epoch ms of the last completed full index, or null if never. */
	lastIndexedAt: number | null;
	/** True while a full run is in progress; cleared only on clean completion, so
	 *  an explicit stop OR a crash/quit leaves it set — the Resume-prompt signal. */
	indexInterrupted: boolean;
	/** Best-effort notes-remaining snapshot at interruption, for messaging. */
	indexRemaining: number | null;

	// Storage — default outside the vault so Obsidian Sync never touches it.
	dbPath: string;
}

export const DEFAULT_SETTINGS: UruSettings = {
	pythonPath: "",
	sidecarCwd: "",
	installed: false,
	chatModelPath: "",
	embedModelPath: "",
	embeddingDimension: 1024, // mxbai-embed-large-v1
	vaultKey: "",
	namespaceId: null,
	extractEntities: true,
	ignoreGlobs: [".obsidian/**", ".trash/**", "templates/**"],
	includeFrontmatter: false,
	autoIndexOnStartup: false,
	lastIndexedAt: null,
	indexInterrupted: false,
	indexRemaining: null,
	dbPath: "",
};

export class UruSettingTab extends PluginSettingTab {
	/** Removes the index-progress subscription while the tab is open. */
	private unsubscribe: (() => void) | null = null;

	constructor(
		app: App,
		private plugin: UruPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		// Drop any subscription left from a previous render before rebuilding.
		this.unsubscribe?.();
		this.unsubscribe = null;
		containerEl.empty();
		const s = this.plugin.settings;

		// ---- Status ---------------------------------------------------------
		new Setting(containerEl).setName("Status").setHeading();

		new Setting(containerEl)
			.setName("Uru")
			.setDesc(this.statusLabel())
			.addButton((b) =>
				b.setButtonText("Re-run setup").onClick(async () => {
					await this.plugin.runSetup();
					this.display();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Copy diagnostics").onClick(async () => {
					await navigator.clipboard.writeText(this.plugin.diagnostics());
					new Notice("Uru diagnostics copied to clipboard");
				}),
			);

		// ---- Indexing (action first, then options) -------------------------
		new Setting(containerEl).setName("Indexing").setHeading();

		let indexBtn!: ButtonComponent;
		let forceBtn!: ButtonComponent;
		let stopBtn!: ButtonComponent;
		const action = new Setting(containerEl)
			.setName("Update the index")
			.setDesc(this.indexSummary())
			.addButton((b) => {
				indexBtn = b
					.setCta()
					.setButtonText("Index new & changed")
					.setTooltip("Index notes added or edited since the last run")
					.onClick(() => void this.plugin.reindex(false));
			})
			.addButton((b) => {
				forceBtn = b
					.setButtonText("Re-index everything")
					.setTooltip("Re-send every note, ignoring the change detector")
					.onClick(() => void this.plugin.reindex(true));
			})
			.addButton((b) => {
				stopBtn = b
					.setWarning()
					.setButtonText("Stop")
					.setTooltip("Stop after the current note finishes")
					.onClick(() => {
						this.plugin.stopIndexing();
						new Notice("Uru: stopping after the current note…");
					});
			});

		const progressEl = containerEl.createDiv("uru-index-progress");
		const fill = progressEl
			.createDiv("uru-index-progress-track")
			.createDiv("uru-index-progress-fill");
		const meta = progressEl.createDiv("uru-index-progress-meta");
		const countEl = meta.createSpan();
		const currentEl = meta.createSpan({ cls: "uru-index-progress-current" });
		const hintEl = progressEl.createDiv("uru-index-progress-hint");
		const interruptedEl = containerEl.createDiv("uru-index-interrupted");

		const apply = (status: IndexStatus | null) => {
			const active = status !== null;
			indexBtn.setDisabled(active);
			forceBtn.setDisabled(active);
			stopBtn.buttonEl.toggle(active);
			progressEl.toggle(active);
			if (status) {
				interruptedEl.toggle(false);
				const pct = status.total ? Math.round((status.done / status.total) * 100) : 0;
				fill.style.width = `${pct}%`;
				const eta = etaSeconds(status);
				const etaTxt = eta !== null ? ` · ${formatEta(eta)}` : "";
				countEl.setText(
					`${status.done.toLocaleString()} / ${status.total.toLocaleString()} notes · ${pct}%${etaTxt}`,
				);
				currentEl.setText(status.current);
				hintEl.setText(this.indexHint());
			} else {
				// Idle: drive the primary button + interrupted notice off the persisted
				// flag, so both revert automatically after a clean resume completes.
				const interrupted = this.plugin.settings.indexInterrupted;
				indexBtn.setButtonText(interrupted ? "Resume indexing" : "Index new & changed");
				indexBtn.setTooltip(
					interrupted
						? "Finish the notes left from the interrupted run"
						: "Index notes added or edited since the last run",
				);
				interruptedEl.setText(interrupted ? this.interruptedText() : "");
				interruptedEl.toggle(interrupted);
				action.setDesc(this.indexSummary());
			}
		};
		// onIndexStatus fires immediately with the current status, then on each tick.
		this.unsubscribe = this.plugin.onIndexStatus(apply);

		new Setting(containerEl)
			.setName("Deep indexing")
			.setDesc(
				"On: Uru also maps the people, places, and ideas across your notes and how they " +
					"connect — richer search and chat, but slower to index (a few seconds per note). " +
					'Off: fast search by meaning only. This is the "Deep" vs "Quick" choice from setup.',
			)
			.addToggle((t) =>
				t.setValue(s.extractEntities).onChange(async (v) => {
					s.extractEntities = v;
					await this.plugin.saveSettings();
					new Notice(
						'Uru: indexing depth changed. Restart Uru, then choose "Re-index ' +
							'everything" to apply it to notes you\'ve already indexed.',
						6000,
					);
				}),
			);

		// ---- Advanced (collapsed) ------------------------------------------
		const advanced = containerEl.createEl("details", { cls: "uru-advanced" });
		advanced.createEl("summary", { text: "Advanced" });

		new Setting(advanced)
			.setName("Index on startup")
			.setDesc("Check for new and changed notes automatically each time Obsidian starts.")
			.addToggle((t) =>
				t.setValue(s.autoIndexOnStartup).onChange(async (v) => {
					s.autoIndexOnStartup = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(advanced)
			.setName("Include frontmatter")
			.setDesc("Also index the YAML frontmatter at the top of each note, not just the body.")
			.addToggle((t) =>
				t.setValue(s.includeFrontmatter).onChange(async (v) => {
					s.includeFrontmatter = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(advanced)
			.setName("Ignore patterns")
			.setDesc("Glob patterns for files and folders to skip — one per line.")
			.addTextArea((t) => {
				t.setValue(s.ignoreGlobs.join("\n")).onChange(async (v) => {
					s.ignoreGlobs = v.split("\n").map((x) => x.trim()).filter(Boolean);
					await this.plugin.saveSettings();
				});
				t.inputEl.rows = 4;
			});

		// ---- Models (collapsed) --------------------------------------------
		const models = containerEl.createEl("details", { cls: "uru-advanced" });
		models.createEl("summary", { text: "Models" });
		new Setting(models)
			.setName("Chat model")
			.setDesc(this.modelName(s.chatModelPath))
			.setDisabled(true);
		new Setting(models)
			.setName("Embedding model")
			.setDesc(
				`${this.modelName(s.embedModelPath)} · ${s.embeddingDimension} dimensions. ` +
					"Changing this needs a full re-index.",
			)
			.setDisabled(true);
	}

	hide(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	/** Plain-language backend status — no raw namespace UUID (kept in diagnostics). */
	private statusLabel(): string {
		const detail = this.plugin.statusDetailText;
		switch (this.plugin.backendState) {
			case "ok":
				return "Ready — Uru is running on your computer.";
			case "starting":
				return detail ? `Setting up… ${detail}` : "Setting up…";
			case "error":
				return `Something went wrong${detail ? ` — ${detail}` : ""}. Try "Re-run setup", or "Copy diagnostics" for support.`;
			default:
				return "Not set up yet — run setup to get started.";
		}
	}

	/** Friendly model name (basename, sans .gguf) from a full model path. */
	private modelName(path: string): string {
		if (!path) return "(set during setup)";
		return path.split("/").pop()!.replace(/\.gguf$/i, "");
	}

	/** One-line summary of index state for the idle (non-running) view. */
	private indexSummary(): string {
		const count = this.plugin.indexedCount();
		const last = this.plugin.settings.lastIndexedAt;
		if (count === 0 && !last) return "No notes indexed yet — run this to make your vault searchable.";
		const notes = `${count.toLocaleString()} ${count === 1 ? "note" : "notes"} indexed`;
		return last ? `${notes} · last updated ${new Date(last).toLocaleString()}.` : `${notes}.`;
	}

	/** Highlighted line shown when a prior run was stopped/crashed before finishing. */
	private interruptedText(): string {
		const n = this.plugin.settings.indexRemaining;
		const left = n && n > 0 ? `about ${n.toLocaleString()} ${n === 1 ? "note" : "notes"} may remain` : "some notes may remain";
		return `Indexing was interrupted — ${left}. Resume to finish.`;
	}

	/** Reassurance shown under the progress bar while indexing runs. */
	private indexHint(): string {
		return this.plugin.settings.extractEntities
			? "Deep indexing runs a local model on every note, so a large vault can take a " +
					"while — often a few seconds per note. You can close this window and keep " +
					"working; indexing continues in the background."
			: "This can take a while on large vaults. You can close this window and keep working; " +
					"indexing continues in the background.";
	}
}
