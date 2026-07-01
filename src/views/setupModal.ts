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
				"Uru adds AI-powered search to your vault, and everything runs on your own " +
				"computer — nothing goes to the cloud, and there's no account or API key to set up. " +
				"The first time, Uru downloads about 3 GB (the AI models it needs) and installs a " +
				"few components. This happens once. Your notes never leave your machine.",
		});

		let fullKg = this.plugin.settings.extractEntities;
		new Setting(contentEl)
			.setName("How much to analyze")
			.setDesc(
				'"Quick" finds notes by meaning, not just keywords — fast to set up. ' +
					'"Deep" does that too, and also maps the people, places, and ideas mentioned ' +
					"across your notes and how they connect. More powerful, but slower to build " +
					"(~5–30 seconds per note the first time). You can switch anytime.",
			)
			.addDropdown((d) =>
				d
					.addOption("lite", "Quick — search by meaning")
					.addOption("full", "Deep — search + connections (slower)")
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
