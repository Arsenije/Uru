import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

interface UruSettings {
	khoraEndpoint: string;
}

const DEFAULT_SETTINGS: UruSettings = {
	khoraEndpoint: "http://localhost:8000",
};

export default class UruPlugin extends Plugin {
	settings: UruSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "uru-recall",
			name: "Recall from knowledge graph",
			callback: () => {
				// TODO: wire up to khora recall()
				console.log("Uru: recall command invoked");
			},
		});

		this.addSettingTab(new UruSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class UruSettingTab extends PluginSettingTab {
	plugin: UruPlugin;

	constructor(app: App, plugin: UruPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("khora endpoint")
			.setDesc("Base URL of the khora service backing Uru.")
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:8000")
					.setValue(this.plugin.settings.khoraEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.khoraEndpoint = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
