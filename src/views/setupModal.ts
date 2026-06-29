import { App, Modal, Notice, Setting } from "obsidian";
import type UruPlugin from "../../main";

/**
 * First-run setup: consent to the (~3 GB, one-time) local-backend download,
 * pick Lite vs Full-KG, then run the bootstrap with live progress. Also reached
 * via Settings → "Re-run setup".
 */
export class SetupModal extends Modal {
	private installing = false;

	constructor(
		app: App,
		private plugin: UruPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Set up Uru" });
		contentEl.createEl("p", {
			text:
				"Uru runs a fully local AI backend on your machine — no cloud, no API keys. " +
				"The first run downloads ~3 GB (a chat model, an embedding model, and the " +
				"llama.cpp runtime) and sets up a private Python environment. Everything " +
				"stays on your computer.",
		});

		let fullKg = this.plugin.settings.extractEntities;
		new Setting(contentEl)
			.setName("Indexing mode")
			.setDesc(
				"Lite = fast semantic search (embeddings only). " +
					"Full = also builds a knowledge graph (entities & relationships) — richer, " +
					"but ~5–30s per note on a local model. You can change this later.",
			)
			.addDropdown((d) =>
				d
					.addOption("lite", "Lite — fast semantic search")
					.addOption("full", "Full — knowledge graph (slower)")
					.setValue(fullKg ? "full" : "lite")
					.onChange((v) => (fullKg = v === "full")),
			);

		const logEl = contentEl.createEl("pre", { cls: "uru-setup-log" });
		logEl.hide();
		const append = (s: string) => {
			logEl.setText((`${logEl.getText()}\n${s}`).slice(-4000));
			logEl.scrollTop = logEl.scrollHeight;
		};

		const buttons = new Setting(contentEl);
		buttons.addButton((b) =>
			b
				.setCta()
				.setButtonText("Install & start")
				.onClick(async () => {
					if (this.installing) return;
					this.installing = true;
					b.setDisabled(true).setButtonText("Installing…");
					logEl.show();
					this.plugin.settings.extractEntities = fullKg;
					await this.plugin.saveSettings();
					try {
						await this.plugin.runBackend(append);
						new Notice("Uru is ready.");
						this.close();
					} catch (e) {
						append(`\nERROR: ${(e as Error).message}`);
						this.installing = false;
						b.setDisabled(false).setButtonText("Retry");
						buttons.addButton((c) =>
							c.setButtonText("Copy diagnostics").onClick(async () => {
								await navigator.clipboard.writeText(
									`${this.plugin.diagnostics()}\n\n--- setup log ---\n${logEl.getText()}`,
								);
								new Notice("Diagnostics copied");
							}),
						);
					}
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
