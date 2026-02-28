import { Notice, Plugin } from "obsidian";
import {
	RemoteVaultSyncSettings,
	DEFAULT_SETTINGS,
	RemoteVaultSyncSettingTab,
} from "./settings";
import { performSync } from "./sync";

interface PluginData {
	settings: RemoteVaultSyncSettings;
	lastSync: string | null;
}

export default class RemoteVaultSyncPlugin extends Plugin {
	settings: RemoteVaultSyncSettings = DEFAULT_SETTINGS;
	lastSync: string | null = null;
	private syncIntervalId: number | null = null;
	private syncing = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new RemoteVaultSyncSettingTab(this.app, this));

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => this.runSync(),
		});

		// Start auto-sync interval
		this.startSyncInterval();

		// Sync on load if configured
		if (this.settings.apiUrl && this.settings.apiToken) {
			// Small delay to let vault finish loading
			setTimeout(() => this.runSync(), 3000);
		}
	}

	onunload(): void {
		this.stopSyncInterval();
	}

	async loadSettings(): Promise<void> {
		const data: Partial<PluginData> | null = await this.loadData();
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			data?.settings ?? data ?? {}
		);
		this.lastSync = data?.lastSync ?? null;
	}

	async saveSettings(): Promise<void> {
		const data: PluginData = {
			settings: this.settings,
			lastSync: this.lastSync,
		};
		await this.saveData(data);
	}

	startSyncInterval(): void {
		this.stopSyncInterval();
		const ms = this.settings.syncIntervalMinutes * 60 * 1000;
		this.syncIntervalId = this.registerInterval(
			window.setInterval(() => this.runSync(), ms)
		);
	}

	stopSyncInterval(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	restartSyncInterval(): void {
		this.startSyncInterval();
	}

	async runSync(): Promise<void> {
		if (this.syncing) {
			new Notice("Remote Vault Sync: sync already in progress");
			return;
		}

		if (!this.settings.apiUrl || !this.settings.apiToken) {
			new Notice(
				"Remote Vault Sync: configure API URL and token in settings"
			);
			return;
		}

		this.syncing = true;

		try {
			const { result, newLastSync } = await performSync(
				this.app,
				this.settings,
				this.lastSync
			);

			this.lastSync = newLastSync;
			await this.saveSettings();

			const parts: string[] = [];
			if (result.created > 0) parts.push(`${result.created} created`);
			if (result.updated > 0) parts.push(`${result.updated} updated`);
			if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
			if (result.errors > 0) parts.push(`${result.errors} errors`);

			if (parts.length === 0) {
				new Notice("Remote Vault Sync: everything up to date");
			} else {
				new Notice(`Remote Vault Sync: ${parts.join(", ")}`);
			}
		} catch (e) {
			const msg =
				e instanceof Error ? e.message : "Unknown error";
			console.error("Remote Vault Sync: sync failed", e);
			new Notice(`Remote Vault Sync failed: ${msg}`);
		} finally {
			this.syncing = false;
		}
	}
}
