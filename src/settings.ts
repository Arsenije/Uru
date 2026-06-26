import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type UruPlugin from "../main";

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
	constructor(
		app: App,
		private plugin: UruPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		containerEl.createEl("h3", { text: "Backend" });

		new Setting(containerEl)
			.setName("Backend status")
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
					new Notice("Uru diagnostics copied");
				}),
			);

		containerEl.createEl("h3", { text: "Indexing" });

		new Setting(containerEl)
			.setName("Extract knowledge graph")
			.setDesc(
				"Full mode runs entity/relationship extraction per note (slower, richer). " +
					"Off = embeddings-only semantic search (much cheaper).",
			)
			.addToggle((t) =>
				t.setValue(s.extractEntities).onChange(async (v) => {
					s.extractEntities = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Index on startup")
			.setDesc("Re-scan the vault for changes each time the plugin loads.")
			.addToggle((t) =>
				t.setValue(s.autoIndexOnStartup).onChange(async (v) => {
					s.autoIndexOnStartup = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Include frontmatter")
			.setDesc("Index the YAML frontmatter text in addition to note body.")
			.addToggle((t) =>
				t.setValue(s.includeFrontmatter).onChange(async (v) => {
					s.includeFrontmatter = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Ignore patterns")
			.setDesc("Glob patterns to skip (one per line).")
			.addTextArea((t) => {
				t.setValue(s.ignoreGlobs.join("\n")).onChange(async (v) => {
					s.ignoreGlobs = v.split("\n").map((x) => x.trim()).filter(Boolean);
					await this.plugin.saveSettings();
				});
				t.inputEl.rows = 4;
			});

		const last = s.lastIndexedAt ? new Date(s.lastIndexedAt).toLocaleString() : "never";
		new Setting(containerEl)
			.setName("Re-index vault")
			.setDesc(`Last indexed: ${last}.`)
			.addButton((b) =>
				b
					.setCta()
					.setButtonText("Index new/changed")
					.onClick(async () => {
						await this.plugin.reindex(false);
						this.display();
					}),
			)
			.addButton((b) =>
				b
					.setButtonText("Force re-index all")
					.setTooltip("Re-send every note, ignoring the change detector")
					.onClick(async () => {
						await this.plugin.reindex(true);
						this.display();
					}),
			);

		containerEl.createEl("h3", { text: "Models" });
		new Setting(containerEl)
			.setName("Chat / extraction model")
			.setDesc(s.chatModelPath || "(set during setup)")
			.setDisabled(true);
		new Setting(containerEl)
			.setName("Embedding model")
			.setDesc(
				`${s.embedModelPath || "(set during setup)"} — dim ${s.embeddingDimension}. ` +
					"Changing this requires a full re-index.",
			)
			.setDisabled(true);
	}
}
