import { Notice, Plugin, TFile, TAbstractFile, normalizePath } from "obsidian";
import {
	RemoteVaultSyncSettings,
	DEFAULT_SETTINGS,
	RemoteVaultSyncSettingTab,
} from "./settings";
import {
	performSync,
	resolveConflicts,
	countConflicts,
	isConflictFile,
	SyncStateMap,
	LocalChange,
} from "./sync";

interface PluginData {
	settings: RemoteVaultSyncSettings;
	lastSync: string | null;
	files: SyncStateMap;
}

export default class RemoteVaultSyncPlugin extends Plugin {
	settings: RemoteVaultSyncSettings = DEFAULT_SETTINGS;
	lastSync: string | null = null;
	fileStates: SyncStateMap = {};
	private syncIntervalId: number | null = null;
	private syncing = false;
	private localChanges: LocalChange[] = [];
	private statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new RemoteVaultSyncSettingTab(this.app, this));

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => this.runSync(),
		});

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar();

		// Register vault event listeners for local change tracking
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				this.onLocalChange("create", file);
			})
		);
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				this.onLocalChange("modify", file);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				this.onLocalChange("delete", file);
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				this.onLocalRename(file, oldPath);
			})
		);

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
		this.fileStates = data?.files ?? {};
	}

	async saveSettings(): Promise<void> {
		const data: PluginData = {
			settings: this.settings,
			lastSync: this.lastSync,
			files: this.fileStates,
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

	/**
	 * Track a local file change (create, modify, delete).
	 * Only tracks changes within the sync folder, ignoring .conflict.md files.
	 */
	private onLocalChange(
		type: "create" | "modify" | "delete",
		file: TAbstractFile
	): void {
		if (!(file instanceof TFile)) return;
		if (this.syncing) return; // ignore changes made by the sync itself

		const syncFolder = normalizePath(this.settings.syncFolder);
		if (!file.path.startsWith(syncFolder + "/")) return;

		const relPath = file.path.slice(syncFolder.length + 1);
		if (isConflictFile(relPath)) return;

		this.localChanges.push({ type, path: file.path });
	}

	/**
	 * Track a local file rename.
	 */
	private onLocalRename(file: TAbstractFile, oldPath: string): void {
		if (!(file instanceof TFile)) return;
		if (this.syncing) return;

		const syncFolder = normalizePath(this.settings.syncFolder);
		const inSyncNew = file.path.startsWith(syncFolder + "/");
		const inSyncOld = oldPath.startsWith(syncFolder + "/");

		if (!inSyncNew && !inSyncOld) return;

		if (inSyncOld && inSyncNew) {
			// Rename within sync folder
			const oldRel = oldPath.slice(syncFolder.length + 1);
			const newRel = file.path.slice(syncFolder.length + 1);
			if (isConflictFile(oldRel) || isConflictFile(newRel)) return;

			this.localChanges.push({
				type: "rename",
				path: file.path,
				oldPath,
			});
		} else if (inSyncOld && !inSyncNew) {
			// Moved out of sync folder — treat as delete
			const oldRel = oldPath.slice(syncFolder.length + 1);
			if (isConflictFile(oldRel)) return;
			this.localChanges.push({ type: "delete", path: oldPath });
		} else if (!inSyncOld && inSyncNew) {
			// Moved into sync folder — treat as create
			const newRel = file.path.slice(syncFolder.length + 1);
			if (isConflictFile(newRel)) return;
			this.localChanges.push({ type: "create", path: file.path });
		}
	}

	/**
	 * Update the status bar to reflect current sync state.
	 */
	private updateStatusBar(syncing?: boolean): void {
		if (!this.statusBarEl) return;

		if (syncing) {
			this.statusBarEl.setText("Remote Vault: syncing...");
			return;
		}

		const conflicts = countConflicts(this.fileStates);
		if (conflicts > 0) {
			this.statusBarEl.setText(
				`Remote Vault: ${conflicts} conflict${conflicts === 1 ? "" : "s"}`
			);
		} else {
			this.statusBarEl.setText("Remote Vault: synced");
		}
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
		this.updateStatusBar(true);

		try {
			// Check for resolved conflicts before syncing
			const syncFolder = normalizePath(this.settings.syncFolder);
			const resolved = await resolveConflicts(
				this.app,
				syncFolder,
				this.fileStates
			);
			if (resolved > 0) {
				await this.saveSettings();
			}

			// Drain the local change queue
			const changes = [...this.localChanges];
			this.localChanges = [];

			const { result, newLastSync, fileStates } = await performSync(
				this.app,
				this.settings,
				this.lastSync,
				{ ...this.fileStates },
				changes
			);

			this.lastSync = newLastSync;
			this.fileStates = fileStates;
			await this.saveSettings();

			const parts: string[] = [];
			if (result.created > 0) parts.push(`${result.created} pulled`);
			if (result.updated > 0) parts.push(`${result.updated} updated`);
			if (result.pushed > 0) parts.push(`${result.pushed} pushed`);
			if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
			if (result.conflicts > 0)
				parts.push(`${result.conflicts} conflicts`);
			if (result.errors > 0) parts.push(`${result.errors} errors`);

			if (parts.length === 0) {
				new Notice("Remote Vault Sync: everything up to date");
			} else {
				new Notice(`Remote Vault Sync: ${parts.join(", ")}`);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			console.error("Remote Vault Sync: sync failed", e);
			new Notice(`Remote Vault Sync failed: ${msg}`);

			// Re-queue changes that weren't processed
			// (they were drained but sync failed, so they're lost — acceptable
			// since next sync will do a full diff anyway)
		} finally {
			this.syncing = false;
			this.updateStatusBar();
		}
	}
}
