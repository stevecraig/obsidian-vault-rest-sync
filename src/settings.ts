import { App, PluginSettingTab, Setting } from "obsidian";
import type RemoteVaultSyncPlugin from "./main";

export interface RemoteVaultSyncSettings {
	apiUrl: string;
	apiToken: string;
	syncFolder: string;
	syncIntervalMinutes: number;
	/** Enable SSE-based live sync for real-time change notifications */
	enableSSE: boolean;
	/** Maximum reconnect delay for SSE in milliseconds */
	sseReconnectMaxMs: number;
	/** Minutes of no incoming SSE events before disconnecting (default: 5) */
	sseEventIdleMinutes: number;
	/** Minutes of no user activity before disconnecting SSE (default: 15) */
	sseUserIdleMinutes: number;
}

export const DEFAULT_SETTINGS: RemoteVaultSyncSettings = {
	apiUrl: "",
	apiToken: "",
	syncFolder: "Remote Vault",
	syncIntervalMinutes: 15,
	enableSSE: true,
	sseReconnectMaxMs: 30000,
	sseEventIdleMinutes: 5,
	sseUserIdleMinutes: 15,
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
			.setDesc("Minutes between automatic syncs (minimum 1). Acts as a fallback when SSE is active.")
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

		containerEl.createEl("h3", { text: "Live sync (SSE)" });

		new Setting(containerEl)
			.setName("Enable live sync")
			.setDesc(
				"Use Server-Sent Events for real-time change notifications. " +
				"When enabled, remote changes are picked up within seconds. " +
				"Polling still runs as a fallback at a longer interval."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableSSE)
					.onChange(async (value) => {
						this.plugin.settings.enableSSE = value;
						await this.plugin.saveSettings();
						this.plugin.restartSSE();
					})
			);

		new Setting(containerEl)
			.setName("Reconnect max delay")
			.setDesc(
				"Maximum delay (in seconds) between SSE reconnection attempts. " +
				"Uses exponential backoff up to this limit."
			)
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(
						String(
							Math.round(
								this.plugin.settings.sseReconnectMaxMs / 1000
							)
						)
					)
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 5) {
							this.plugin.settings.sseReconnectMaxMs =
								num * 1000;
							await this.plugin.saveSettings();
							this.plugin.restartSSE();
						}
					})
			);

		new Setting(containerEl)
			.setName("Event idle timeout")
			.setDesc(
				"Minutes with no incoming SSE events before disconnecting. " +
				"The connection will resume automatically on user activity."
			)
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(
						String(this.plugin.settings.sseEventIdleMinutes)
					)
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 1) {
							this.plugin.settings.sseEventIdleMinutes = num;
							await this.plugin.saveSettings();
							this.plugin.restartSSE();
						}
					})
			);

		new Setting(containerEl)
			.setName("User idle timeout")
			.setDesc(
				"Minutes with no user activity before disconnecting SSE. " +
				"Activity includes editing files, switching tabs, and focusing the window."
			)
			.addText((text) =>
				text
					.setPlaceholder("15")
					.setValue(
						String(this.plugin.settings.sseUserIdleMinutes)
					)
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 1) {
							this.plugin.settings.sseUserIdleMinutes = num;
							await this.plugin.saveSettings();
							this.plugin.restartSSE();
						}
					})
			);
	}
}
