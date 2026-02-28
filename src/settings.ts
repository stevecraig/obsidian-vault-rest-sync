import { App, PluginSettingTab, Setting } from "obsidian";
import type RemoteVaultSyncPlugin from "./main";

export interface RemoteVaultSyncSettings {
	apiUrl: string;
	apiToken: string;
	syncFolder: string;
	syncIntervalMinutes: number;
}

export const DEFAULT_SETTINGS: RemoteVaultSyncSettings = {
	apiUrl: "",
	apiToken: "",
	syncFolder: "Remote Vault",
	syncIntervalMinutes: 15,
};

export class RemoteVaultSyncSettingTab extends PluginSettingTab {
	plugin: RemoteVaultSyncPlugin;

	constructor(app: App, plugin: RemoteVaultSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("API URL")
			.setDesc(
				"Base URL of the REST file API. Should return a file listing on GET."
			)
			.addText((text) =>
				text
					.setPlaceholder("https://...")
					.setValue(this.plugin.settings.apiUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API Token")
			.setDesc("Bearer token for authenticating with the API.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("Token")
					.setValue(this.plugin.settings.apiToken)
					.onChange(async (value) => {
						this.plugin.settings.apiToken = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Sync folder")
			.setDesc(
				"Local vault folder where remote files will be synced into."
			)
			.addText((text) =>
				text
					.setPlaceholder("Remote Vault")
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncFolder =
							value.trim() || "Remote Vault";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sync interval")
			.setDesc("Minutes between automatic syncs (minimum 1).")
			.addText((text) =>
				text
					.setPlaceholder("15")
					.setValue(
						String(this.plugin.settings.syncIntervalMinutes)
					)
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 1) {
							this.plugin.settings.syncIntervalMinutes = num;
							await this.plugin.saveSettings();
							this.plugin.restartSyncInterval();
						}
					})
			);
	}
}
