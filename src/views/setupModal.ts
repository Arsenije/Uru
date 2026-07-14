import { App, Modal, Notice, Setting } from "obsidian";
import type UruPlugin from "../../main";

/**
 * First-run setup: consent to the (~3 GB, one-time) local-backend download,
 * then run the bootstrap with live progress. Also reached via Settings →
 * "Re-run setup".
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
				"Uru adds AI-powered search to your vault — everything runs locally on your " +
				"computer, with no cloud, no account, and no API key. The first run downloads " +
				"about 3 GB of AI models and installs a few components, one time only.",
		});

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
					b.setDisabled(true).setButtonText("Installing… (this can take a few minutes)");
					logEl.show();
					try {
						await this.plugin.runBackend(append);
						new Notice("Uru is ready.");
						this.close();
					} catch (e) {
						append(`\nError: ${(e as Error).message}`);
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
