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
	sha256,
	SyncStateMap,
	LocalChange,
} from "./sync";
import { SyncDecorator } from "./decorations";
import { readFile } from "./api";
import { SSEClient, SSEFileEvent } from "./sse";

interface PluginData {
	settings: RemoteVaultSyncSettings;
	lastSync: string | null;
	files: SyncStateMap;
}

/** Default polling interval (minutes) when SSE is connected and healthy */
const SSE_FALLBACK_INTERVAL_MINUTES = 30;

/**
 * Derive the SSE events URL from the REST files API URL.
 * Expected input:  https://host/user/api/slug/files  (with or without trailing slash)
 * Expected output: https://host/user/api/slug/events
 */
function deriveEventsUrl(apiUrl: string): string | null {
	// Strip trailing slashes and the /files segment
	const stripped = apiUrl.replace(/\/+$/, "");
	const match = stripped.match(/^(https?:\/\/.+\/api\/[^/]+)\/files$/i);
	if (match) {
		return match[1] + "/events";
	}
	// If the URL doesn't end in /files, try appending /events as sibling
	// e.g. https://host/user/api/slug → https://host/user/api/slug/events
	const segMatch = stripped.match(/^(https?:\/\/.+\/api\/[^/]+)$/i);
	if (segMatch) {
		return segMatch[1] + "/events";
	}
	return null;
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
	private sseClient: SSEClient | null = null;
	/** Whether SSE is currently connected (used to lengthen poll interval) */
	private sseConnected = false;

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

		// Start SSE if enabled
		this.startSSE();

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
		this.stopSSE();
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
		// Use a longer polling interval when SSE is connected and healthy
		const intervalMinutes = this.sseConnected
			? Math.max(
					this.settings.syncIntervalMinutes,
					SSE_FALLBACK_INTERVAL_MINUTES
			  )
			: this.settings.syncIntervalMinutes;
		const ms = intervalMinutes * 60 * 1000;
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

	/** Start SSE connection if enabled and configured */
	startSSE(): void {
		this.stopSSE();

		if (!this.settings.enableSSE) return;
		if (!this.settings.apiUrl || !this.settings.apiToken) return;

		const eventsUrl = deriveEventsUrl(this.settings.apiUrl);
		if (!eventsUrl) {
			console.warn(
				"Remote Vault Sync: could not derive SSE events URL from API URL"
			);
			return;
		}

		this.sseClient = new SSEClient({
			url: eventsUrl,
			token: this.settings.apiToken,
			reconnectMaxMs: this.settings.sseReconnectMaxMs,
			onFileChanged: (event: SSEFileEvent) =>
				this.onSSEFileChanged(event),
			onFileDeleted: (event: SSEFileEvent) =>
				this.onSSEFileDeleted(event),
			onConnected: () => {
				this.sseConnected = true;
				this.updateStatusBar();
				// Lengthen polling interval while SSE is active
				this.startSyncInterval();
				console.log("Remote Vault Sync: SSE connected");
			},
			onDisconnected: () => {
				this.sseConnected = false;
				this.updateStatusBar();
				// Restore normal polling interval
				this.startSyncInterval();
				console.log("Remote Vault Sync: SSE disconnected, will reconnect");
			},
			onError: (err: Error) => {
				console.error("Remote Vault Sync: SSE error", err);
			},
		});

		this.sseClient.start();
	}

	/** Stop SSE connection */
	stopSSE(): void {
		if (this.sseClient) {
			this.sseClient.stop();
			this.sseClient = null;
		}
		this.sseConnected = false;
	}

	/** Restart SSE (called from settings changes) */
	restartSSE(): void {
		this.startSSE();
	}

	/**
	 * Handle a file_changed SSE event by pulling the single file
	 * if it differs from local state.
	 */
	private async onSSEFileChanged(event: SSEFileEvent): Promise<void> {
		if (this.syncing) return;

		const remotePath = event.path;
		if (!remotePath) return;
		if (isConflictFile(remotePath)) return;

		const state = this.fileStates[remotePath];

		// If we have a hash and it matches the event hash, file is up to date
		if (
			event.hash &&
			state?.remoteHash &&
			event.hash === state.remoteHash
		) {
			return;
		}

		// Pull the single file
		try {
			this.syncing = true;

			const syncFolder = normalizePath(this.settings.syncFolder);
			const file = await readFile(
				this.settings.apiUrl,
				this.settings.apiToken,
				remotePath,
				state?.remoteHash ?? undefined
			);

			if (!file) return; // 304 not modified

			const localPath = normalizePath(
				`${syncFolder}/${remotePath}`
			);

			// Ensure parent folder exists
			const parentPath = localPath.substring(
				0,
				localPath.lastIndexOf("/")
			);
			if (parentPath) {
				const parentFolder =
					this.app.vault.getAbstractFileByPath(parentPath);
				if (!parentFolder) {
					await this.app.vault.createFolder(parentPath);
				}
			}

			// Write or update the local file
			const existing =
				this.app.vault.getAbstractFileByPath(localPath);
			if (existing instanceof TFile) {
				// Check if local file was modified since last sync
				const localContent = await this.app.vault.read(existing);
				const localHash = await sha256(localContent);
				if (state?.localHash && localHash !== state.localHash) {
					// Local was also modified — skip, let full sync handle conflict
					console.log(
						`Remote Vault Sync: SSE skipping ${remotePath} — local also modified`
					);
					return;
				}
				await this.app.vault.modify(existing, file.content);
			} else {
				await this.app.vault.create(localPath, file.content);
			}

			// Compute content hash for local state
			const contentHash = file.hash ?? (await sha256(file.content));

			// Update file state
			this.fileStates[remotePath] = {
				remoteSyncedAt: file.updatedAt,
				localModifiedAt: Date.now(),
				status: "synced",
				remoteHash: contentHash,
				localHash: contentHash,
			};
			await this.saveSettings();
			this.updateStatusBar();
		} catch (e) {
			console.error(
				`Remote Vault Sync: SSE pull failed for ${remotePath}`,
				e
			);
		} finally {
			this.syncing = false;
		}
	}

	/**
	 * Handle a file_deleted SSE event — schedule a full sync
	 * rather than deleting locally (deletion needs full state context).
	 */
	private onSSEFileDeleted(_event: SSEFileEvent): void {
		// File deletion is complex (needs to check local modifications,
		// conflict state, etc.). Queue a full sync instead.
		if (!this.syncing) {
			this.runSync();
		}
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
			const liveIndicator = this.sseConnected ? " [live]" : "";
			this.statusBarEl.setText(
				`Remote Vault: synced${liveIndicator}`
			);
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
