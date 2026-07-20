import {
	App,
	ButtonComponent,
	PluginSettingTab,
	Setting,
	Notice,
	type SettingDefinitionItem,
} from "obsidian";
import type { default as UruPlugin } from "../main";
import { etaSeconds, formatEta, type IndexStatus } from "./indexing/indexer";
import { ConfirmModal } from "./views/confirmModal";
import type { VaultRegistryEntry } from "./vaultRegistry";

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
	// Placeholder — loadSettings overlays defaultIgnoreGlobs(app), since the
	// config folder is user-relocatable and only known once the vault is open.
	ignoreGlobs: [],
	includeFrontmatter: false,
	autoIndexOnStartup: false,
	lastIndexedAt: null,
	indexInterrupted: false,
	indexRemaining: null,
	dbPath: "",
};

/** Default ignore globs, resolved against the vault's actual config folder
 *  (users can rename `.obsidian`, so it can't be a static literal). */
export function defaultIgnoreGlobs(app: App): string[] {
	return [`${app.vault.configDir}/**`, ".trash/**", "templates/**"];
}

/** Deep links into the README sections explaining each model choice. */
const MODEL_DOCS = {
	chat: "https://github.com/Arsenije/Uru#the-chat-model",
	embedding: "https://github.com/Arsenije/Uru#the-embedding-model",
} as const;

export class UruSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: UruPlugin,
	) {
		super(app, plugin);
	}

	// Declarative settings (Obsidian 1.13+): static controls are definitions so
	// they show up in the app-wide settings search; the live rows (status,
	// index progress, uninstall preflight) stay imperative via `render`, whose
	// returned cleanup replaces the old display()/hide() subscription bookkeeping.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Status",
				items: [
					{
						name: "Uru setup",
						aliases: ["status", "repair", "diagnostics"],
						render: (setting) => this.renderStatusRow(setting),
					},
				],
			},
			{
				type: "group",
				heading: "Indexing",
				items: [
					{
						name: "Update the index",
						aliases: ["reindex", "index vault", "resume indexing"],
						render: (setting) => this.renderIndexRow(setting),
					},
					{
						name: "Index on startup",
						desc: "Check for new and edited notes automatically each time Obsidian starts.",
						control: { type: "toggle", key: "autoIndexOnStartup" },
					},
				],
			},
			{
				type: "page",
				name: "Advanced",
				items: [
					{
						name: "Include frontmatter",
						desc: "Also index the YAML frontmatter at the top of each note, not just the body.",
						control: { type: "toggle", key: "includeFrontmatter" },
					},
					{
						name: "Ignore patterns",
						desc: "Glob patterns for files and folders to skip — one per line.",
						control: { type: "textarea", key: "ignoreGlobs", rows: 4 },
					},
				],
			},
			{
				type: "page",
				name: "Models",
				items: [
					{
						name: "Chat model",
						desc: this.modelDesc(this.modelName(this.plugin.settings.chatModelPath), MODEL_DOCS.chat),
					},
					{
						name: "Embedding model",
						desc: this.modelDesc(
							`${this.modelName(this.plugin.settings.embedModelPath)} · ${this.plugin.settings.embeddingDimension} dimensions.`,
							MODEL_DOCS.embedding,
						),
					},
				],
			},
			{
				type: "page",
				name: "Danger zone",
				items: [
					{
						name: "Nothing to uninstall yet",
						desc: "Set up Uru first.",
						searchable: false,
						visible: () => !this.plugin.settings.vaultKey,
					},
					{
						name: "Uninstall Uru",
						aliases: ["remove", "delete data", "uninstall"],
						visible: () => !!this.plugin.settings.vaultKey,
						render: (setting) => this.renderUninstallRow(setting),
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		switch (key) {
			case "autoIndexOnStartup":
				return s.autoIndexOnStartup;
			case "includeFrontmatter":
				return s.includeFrontmatter;
			case "ignoreGlobs":
				return s.ignoreGlobs.join("\n");
			default:
				return undefined;
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		switch (key) {
			case "autoIndexOnStartup":
				s.autoIndexOnStartup = Boolean(value);
				break;
			case "includeFrontmatter":
				s.includeFrontmatter = Boolean(value);
				break;
			case "ignoreGlobs":
				s.ignoreGlobs = String(value)
					.split("\n")
					.map((x) => x.trim())
					.filter(Boolean);
				break;
			default:
				return;
		}
		await this.plugin.saveSettings();
		// Live file events must honor the new patterns immediately — waiting for
		// the next full index would keep indexing content the user just asked
		// Uru to skip.
		if (key === "ignoreGlobs") this.plugin.applyIgnorePatterns();
	}

	/** Status row: Repair/diagnostics buttons plus a live status line — the
	 *  sidecar boots asynchronously, so without the subscription the row would
	 *  stay on "Setting up…" until the tab is reopened. onBackendStatus fires
	 *  immediately and on every change; we only refresh the desc (no re-render)
	 *  so setup-progress ticks update smoothly without rebuilding the page. */
	private renderStatusRow(setting: Setting): () => void {
		setting
			.addButton((b) =>
				b.setButtonText("Repair Uru").onClick(async () => {
					await this.plugin.runSetup();
					this.update();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Copy diagnostics").onClick(async () => {
					await navigator.clipboard.writeText(this.plugin.diagnostics());
					new Notice("Diagnostics copied");
				}),
			);
		return this.plugin.onBackendStatus(() => {
			setting.setDesc(this.statusLabel());
		});
	}

	/** Index action row plus the progress bar / interrupted notice it drives. */
	private renderIndexRow(setting: Setting): () => void {
		setting.setDesc(this.indexSummary());

		let indexBtn!: ButtonComponent;
		let forceBtn!: ButtonComponent;
		let stopBtn!: ButtonComponent;
		setting
			.addButton((b) => {
				indexBtn = b
					.setCta()
					.setButtonText("Index new & edited")
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
					.setButtonText("Stop")
					.setTooltip("Stop after the current note finishes")
					.onClick(() => {
						this.plugin.stopIndexing();
						new Notice("Stopping after the current note…");
					});
			});

		// The progress bar and interrupted notice are full-width blocks, so they
		// live as siblings after the row, not inside its flex layout.
		const interruptedEl = createDiv("uru-index-interrupted");
		const progressEl = createDiv("uru-index-progress");
		setting.settingEl.insertAdjacentElement("afterend", interruptedEl);
		setting.settingEl.insertAdjacentElement("afterend", progressEl);
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
				interruptedEl.toggle(false);
				const pct = status.total ? Math.round((status.done / status.total) * 100) : 0;
				fill.style.setProperty("--uru-progress", `${pct}%`);
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
				indexBtn.setButtonText(interrupted ? "Resume indexing" : "Index new & edited");
				indexBtn.setTooltip(
					interrupted
						? "Finish indexing the notes left from the interrupted run"
						: "Index notes added or edited since the last run",
				);
				interruptedEl.setText(interrupted ? this.interruptedText() : "");
				interruptedEl.toggle(interrupted);
				setting.setDesc(this.indexSummary());
			}
		};
		// onIndexStatus fires immediately with the current status, then on each tick.
		const unsubscribe = this.plugin.onIndexStatus(apply);
		return () => {
			unsubscribe();
			// The framework tears down the row itself; the siblings are ours to remove.
			progressEl.remove();
			interruptedEl.remove();
		};
	}

	/** Uninstall row: disabled until the other-vaults preflight comes back clean. */
	private renderUninstallRow(setting: Setting): void {
		setting.setDesc("Checking other vaults…");
		let removeAllBtn!: ButtonComponent;
		setting.addButton((b) => {
			removeAllBtn = b
				.setDestructive()
				.setButtonText("Uninstall")
				.onClick(() => void this.confirmDelete());
		});
		void this.plugin.deleteDataPreflight().then(({ otherVaults }) => {
			setting.setDesc(this.removeAllDesc(otherVaults));
			removeAllBtn.setDisabled(Array.isArray(otherVaults) && otherVaults.length > 0);
		});
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
				return `Something went wrong${detail ? ` — ${detail}` : ""}. Try "Repair Uru", or "Copy diagnostics" for support.`;
			default:
				return "Not set up yet — run setup to get started.";
		}
	}

	/** Description for a (display-only) model row: name plus a "Why this model?" link. */
	private modelDesc(text: string, href: string): DocumentFragment {
		return createFragment((f) => {
			f.appendText(text);
			f.createEl("br");
			f.createEl("a", {
				text: "Why this model?",
				href,
				attr: { target: "_blank", rel: "noopener" },
			});
		});
	}

	/** Friendly model name (basename, sans .gguf) from a full model path. */
	private modelName(path: string): string {
		if (!path) return "(set during setup)";
		// Split on both separators — paths are built with join(), so Windows
		// users get backslashes.
		return path.split(/[\\/]/).pop()!.replace(/\.gguf$/i, "");
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
		return "This can take a while on large vaults. You can close this window and keep working; " +
			"indexing continues in the background.";
	}

	/** Description for the "Uninstall Uru" row, based on registry lookup. */
	private removeAllDesc(otherVaults: VaultRegistryEntry[] | "unknown"): string {
		if (otherVaults === "unknown") {
			return "Uru couldn't check whether other vaults still use the local AI service — " +
				"you'll be asked to confirm before anything is deleted.";
		}
		if (otherVaults.length > 0) {
			const names = otherVaults.map((v) => v.vaultName).join(", ");
			return `Unavailable — Uru is also used in: ${names}. Uninstalling would delete the shared ` +
				"AI service those vaults rely on. To stop using Uru here only, disable it from " +
				"Community plugins in this vault; the shared service stays for the others.";
		}
		return "Do this before removing Uru from Community plugins — it deletes the shared local AI " +
			"service (Python environment + AI models, several GB) and this vault's Uru data.";
	}

	/** Confirm the uninstall, then run it and refresh the tab. */
	private async confirmDelete(): Promise<void> {
		const { otherVaults } = await this.plugin.deleteDataPreflight();
		const message =
			otherVaults === "unknown"
				? [
						"Uru couldn't check whether another vault still uses the local AI service.",
						"Only continue if you're sure no other vault has Uru installed.",
						"This removes the local AI service (Python environment + AI models, several GB) and this vault's data.",
					]
				: [
						"This uninstalls the local AI service (Python environment + AI models, several GB) " +
							"plus this vault's data.",
						"After this finishes, it's safe to remove the Uru plugin from Community plugins.",
					];
		new ConfirmModal(this.app, {
			title: "Uninstall Uru?",
			message,
			confirmText: "Uninstall",
			onConfirm: async () => {
				await this.plugin.deleteData();
				this.update();
			},
		}).open();
	}
}
