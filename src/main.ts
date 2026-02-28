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
import { SyncDecorator } from "./decorations";

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
	private decorator: SyncDecorator | null = null;

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

		// File explorer sync status badges
		this.decorator = new SyncDecorator(this, this.settings.syncFolder);
		this.decorator.register();
		this.refreshDecorations();

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
		if (this.decorator) {
			this.decorator.destroy();
			this.decorator = null;
		}
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
	 * Push current sync state and change queue into the file explorer decorator.
	 */
	private refreshDecorations(): void {
		if (!this.decorator) return;
		this.decorator.setSyncFolder(this.settings.syncFolder);
		const queuePaths = this.localChanges
			.filter((c) => c.type !== "delete")
			.map((c) => c.path);
		this.decorator.updateDecorations(this.fileStates, queuePaths);
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
		this.refreshDecorations();
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

		this.refreshDecorations();
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

		let changes: LocalChange[] = [];
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
			changes = [...this.localChanges];
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

			// Restore un-processed changes — prepend failed batch before any new
			// changes that arrived during sync to preserve ordering
			this.localChanges = [...changes, ...this.localChanges];
		} finally {
			this.syncing = false;
			this.updateStatusBar();
			this.refreshDecorations();
		}
	}
}
