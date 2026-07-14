import { App, Modal, Setting } from "obsidian";

export interface ConfirmModalOptions {
	title: string;
	/** One paragraph per array entry. */
	message: string[];
	confirmText: string;
	cancelText?: string;
	onConfirm: () => void | Promise<void>;
}

/** Generic destructive-action confirmation dialog (no confirm primitive existed before this). */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private opts: ConfirmModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.opts.title);
		for (const para of this.opts.message) {
			contentEl.createEl("p", { text: para });
		}

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText(this.opts.cancelText ?? "Cancel").onClick(() => this.close()),
			)
			.addButton((b) =>
				b
					.setWarning()
					.setButtonText(this.opts.confirmText)
					.onClick(async () => {
						this.close();
						await this.opts.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
