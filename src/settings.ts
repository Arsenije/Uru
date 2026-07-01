import { App, ButtonComponent, PluginSettingTab, Setting, Notice } from "obsidian";
import type UruPlugin from "../main";
import type { IndexStatus } from "./indexing/indexer";

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

		// ---- Backend --------------------------------------------------------
		new Setting(containerEl).setName("Backend").setHeading();

		new Setting(containerEl)
			.setName("Status")
			.setDesc(this.plugin.statusText())
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

		// ---- Indexing options ----------------------------------------------
		new Setting(containerEl).setName("Indexing").setHeading();

		new Setting(containerEl)
			.setName("Extract knowledge graph")
			.setDesc(
				"Full mode reads every note with a local model to pull out entities and how " +
					"they relate — richer recall and chat, but slower to index. Turn it off for " +
					"embeddings-only semantic search: much faster and lighter, with no entity graph.",
			)
			.addToggle((t) =>
				t.setValue(s.extractEntities).onChange(async (v) => {
					s.extractEntities = v;
					await this.plugin.saveSettings();
					new Notice(
						"Uru: indexing mode changed. Restart the backend, then run a full " +
							"re-index to apply it to existing notes.",
						6000,
					);
				}),
			);

		new Setting(containerEl)
			.setName("Index on startup")
			.setDesc("Scan the vault for new and changed notes automatically each time Obsidian loads.")
			.addToggle((t) =>
				t.setValue(s.autoIndexOnStartup).onChange(async (v) => {
					s.autoIndexOnStartup = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Include frontmatter")
			.setDesc("Index the YAML frontmatter at the top of each note, not just the body text.")
			.addToggle((t) =>
				t.setValue(s.includeFrontmatter).onChange(async (v) => {
					s.includeFrontmatter = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Ignore patterns")
			.setDesc("Glob patterns for files and folders to skip — one per line.")
			.addTextArea((t) => {
				t.setValue(s.ignoreGlobs.join("\n")).onChange(async (v) => {
					s.ignoreGlobs = v.split("\n").map((x) => x.trim()).filter(Boolean);
					await this.plugin.saveSettings();
				});
				t.inputEl.rows = 4;
			});

		// ---- Index your vault (action + live progress) ---------------------
		new Setting(containerEl).setName("Index your vault").setHeading();

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

		const apply = (status: IndexStatus | null) => {
			const active = status !== null;
			indexBtn.setDisabled(active);
			forceBtn.setDisabled(active);
			stopBtn.buttonEl.toggle(active);
			progressEl.toggle(active);
			if (status) {
				const pct = status.total ? Math.round((status.done / status.total) * 100) : 0;
				fill.style.width = `${pct}%`;
				countEl.setText(
					`${status.done.toLocaleString()} / ${status.total.toLocaleString()} notes · ${pct}%`,
				);
				currentEl.setText(status.current);
				hintEl.setText(this.indexHint());
			} else {
				action.setDesc(this.indexSummary());
			}
		};
		// onIndexStatus fires immediately with the current status, then on each tick.
		this.unsubscribe = this.plugin.onIndexStatus(apply);

		// ---- Models ---------------------------------------------------------
		new Setting(containerEl).setName("Models").setHeading();
		new Setting(containerEl)
			.setName("Chat / extraction model")
			.setDesc(s.chatModelPath || "(set during setup)")
			.setDisabled(true);
		new Setting(containerEl)
			.setName("Embedding model")
			.setDesc(
				`${s.embedModelPath || "(set during setup)"} — ${s.embeddingDimension} dimensions. ` +
					"Changing this requires a full re-index.",
			)
			.setDisabled(true);
	}

	hide(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	/** One-line summary of index state for the idle (non-running) view. */
	private indexSummary(): string {
		const count = this.plugin.indexedCount();
		const last = this.plugin.settings.lastIndexedAt;
		if (count === 0 && !last) return "No notes indexed yet.";
		const notes = `${count.toLocaleString()} ${count === 1 ? "note" : "notes"} indexed`;
		return last ? `${notes} · last updated ${new Date(last).toLocaleString()}.` : `${notes}.`;
	}

	/** Reassurance shown under the progress bar while indexing runs. */
	private indexHint(): string {
		return this.plugin.settings.extractEntities
			? "Knowledge-graph extraction runs a local model on every note, so this can take a " +
					"while — often a few seconds per note on large vaults. You can close this window " +
					"and keep working; indexing continues in the background."
			: "This can take a while on large vaults. You can close this window and keep working; " +
					"indexing continues in the background.";
	}
}
