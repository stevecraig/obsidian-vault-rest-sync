import { App, TFile, TFolder, normalizePath } from "obsidian";
import {
	listFiles,
	readFile,
	writeFile,
	deleteFile,
	FileListEntry,
	ApiError,
} from "./api";
import type { RemoteVaultSyncSettings } from "./settings";

/** Per-file sync status */
export type FileSyncStatus =
	| "synced"
	| "conflicted"
	| "pendingPush"
	| "pendingPull";

/** Per-file sync state stored in plugin data */
export interface FileSyncState {
	remoteSyncedAt: string;
	localModifiedAt: number;
	status: FileSyncStatus;
}

/** The full sync state stored in plugin data.files */
export type SyncStateMap = Record<string, FileSyncState>;

/** Result counters for a sync run */
export interface SyncResult {
	created: number;
	updated: number;
	deleted: number;
	pushed: number;
	conflicts: number;
	errors: number;
}

/** A queued local change event */
export interface LocalChange {
	type: "create" | "modify" | "delete" | "rename";
	path: string;
	/** For renames, the old path */
	oldPath?: string;
}

const CONFLICT_BANNER =
	"> [!danger] CONFLICT: This file was modified both locally and on the server.\n" +
	"> A copy of the remote version has been saved as `%CONFLICT_PATH%`.\n" +
	"> Resolve the conflict manually, then delete the `.conflict.md` file.\n\n";

const CONFLICT_SUFFIX = ".conflict.md";

/**
 * Perform a two-way sync:
 * 1. Fetch remote changes
 * 2. Compare with local state and queued changes
 * 3. Pull / push / detect conflicts / handle deletes
 * 4. Update per-file sync state
 */
export async function performSync(
	app: App,
	settings: RemoteVaultSyncSettings,
	lastSync: string | null,
	fileStates: SyncStateMap,
	localChanges: LocalChange[],
	onProgress?: (msg: string) => void
): Promise<{ result: SyncResult; newLastSync: string; fileStates: SyncStateMap }> {
	if (!settings.apiUrl || !settings.apiToken) {
		throw new Error("API URL and token must be configured in settings");
	}

	const result: SyncResult = {
		created: 0,
		updated: 0,
		deleted: 0,
		pushed: 0,
		conflicts: 0,
		errors: 0,
	};

	const syncFolder = normalizePath(settings.syncFolder);
	await ensureFolder(app, syncFolder);

	// Build set of locally changed paths from the change queue
	const localChangedPaths = new Set<string>();
	const localDeletedPaths = new Set<string>();
	const localRenames = new Map<string, string>(); // oldPath -> newPath

	for (const change of localChanges) {
		const relPath = toRelativePath(change.path, syncFolder);
		if (relPath === null) continue; // outside sync folder
		if (isConflictFile(relPath)) continue; // ignore .conflict.md files

		if (change.type === "delete") {
			localDeletedPaths.add(relPath);
			localChangedPaths.delete(relPath);
		} else if (change.type === "rename" && change.oldPath) {
			const oldRel = toRelativePath(change.oldPath, syncFolder);
			if (oldRel !== null) {
				localDeletedPaths.add(oldRel);
				localRenames.set(oldRel, relPath);
			}
			localChangedPaths.add(relPath);
			localDeletedPaths.delete(relPath);
		} else {
			localChangedPaths.add(relPath);
			localDeletedPaths.delete(relPath);
		}
	}

	// 1. Fetch remote file list (full list for deletion detection)
	onProgress?.("Fetching file list...");
	let remoteFiles: FileListEntry[];
	try {
		remoteFiles = await listFiles(settings.apiUrl, settings.apiToken);
	} catch (e) {
		if (e instanceof ApiError) {
			throw new Error(`Failed to list files: ${e.message}`);
		}
		throw e;
	}

	const remoteMap = new Map<string, FileListEntry>();
	for (const f of remoteFiles) {
		remoteMap.set(f.path, f);
	}

	// Build map of local files in sync folder
	const localFiles = getLocalFiles(app, syncFolder);
	const localFileMap = new Map<string, TFile>();
	for (const file of localFiles) {
		const rel = file.path.slice(syncFolder.length + 1);
		if (!isConflictFile(rel)) {
			localFileMap.set(rel, file);
		}
	}

	// Track all paths we've processed
	const processedPaths = new Set<string>();

	// 2. Process remote files
	for (const [remotePath, remoteEntry] of remoteMap) {
		processedPaths.add(remotePath);
		const state = fileStates[remotePath];
		const localFile = localFileMap.get(remotePath);
		const remoteUpdatedAt = new Date(remoteEntry.updatedAt).getTime();
		const isLocallyChanged = localChangedPaths.has(remotePath);
		const isLocallyDeleted = localDeletedPaths.has(remotePath);

		if (isLocallyDeleted) {
			// Local deleted, remote exists
			if (state && remoteUpdatedAt > new Date(state.remoteSyncedAt).getTime()) {
				// Remote was modified since last sync — conflict: re-pull
				onProgress?.(`Conflict (deleted locally, changed remotely): ${remotePath}`);
				try {
					await pullFile(app, settings, syncFolder, remotePath, result, "created");
					fileStates[remotePath] = {
						remoteSyncedAt: remoteEntry.updatedAt,
						localModifiedAt: Date.now(),
						status: "conflicted",
					};
					result.conflicts++;
				} catch (e) {
					console.error(`Remote Vault Sync: conflict re-pull failed for ${remotePath}`, e);
					result.errors++;
				}
			} else {
				// Remote untouched — delete on server
				onProgress?.(`Deleting remote: ${remotePath}`);
				try {
					const deleted = await deleteFile(
						settings.apiUrl,
						settings.apiToken,
						remotePath
					);
					if (deleted) {
						result.deleted++;
					} else {
						// Server doesn't support DELETE — can't sync this deletion
						console.warn(
							`Remote Vault Sync: server doesn't support DELETE for ${remotePath}`
						);
					}
					delete fileStates[remotePath];
				} catch (e) {
					console.error(`Remote Vault Sync: delete failed for ${remotePath}`, e);
					result.errors++;
				}
			}
			continue;
		}

		if (!localFile && !state) {
			// New remote file, no local version — pull
			onProgress?.(`Pulling new: ${remotePath}`);
			try {
				await pullFile(app, settings, syncFolder, remotePath, result, "created");
				fileStates[remotePath] = {
					remoteSyncedAt: remoteEntry.updatedAt,
					localModifiedAt: Date.now(),
					status: "synced",
				};
			} catch (e) {
				console.error(`Remote Vault Sync: pull failed for ${remotePath}`, e);
				result.errors++;
			}
			continue;
		}

		if (!localFile && state) {
			// File was in sync state but is gone locally
			// If we didn't track it as a local delete, it was deleted outside our events
			// Treat as local delete + remote unchanged → delete on server
			if (remoteUpdatedAt > new Date(state.remoteSyncedAt).getTime()) {
				// Remote changed — re-pull
				onProgress?.(`Re-pulling (missing locally, changed remotely): ${remotePath}`);
				try {
					await pullFile(app, settings, syncFolder, remotePath, result, "created");
					fileStates[remotePath] = {
						remoteSyncedAt: remoteEntry.updatedAt,
						localModifiedAt: Date.now(),
						status: "synced",
					};
				} catch (e) {
					console.error(`Remote Vault Sync: re-pull failed for ${remotePath}`, e);
					result.errors++;
				}
			} else {
				// Remote unchanged — delete on server
				onProgress?.(`Deleting remote (missing locally): ${remotePath}`);
				try {
					const deleted = await deleteFile(
						settings.apiUrl,
						settings.apiToken,
						remotePath
					);
					if (deleted) {
						result.deleted++;
					}
					delete fileStates[remotePath];
				} catch (e) {
					console.error(`Remote Vault Sync: delete failed for ${remotePath}`, e);
					result.errors++;
				}
			}
			continue;
		}

		if (localFile) {
			const remoteChanged = state
				? remoteUpdatedAt > new Date(state.remoteSyncedAt).getTime()
				: true; // no state = first sync, treat remote as authoritative unless locally changed

			if (remoteChanged && isLocallyChanged) {
				// Both changed — conflict
				onProgress?.(`Conflict: ${remotePath}`);
				try {
					await createConflict(app, settings, syncFolder, remotePath, localFile);
					fileStates[remotePath] = {
						remoteSyncedAt: remoteEntry.updatedAt,
						localModifiedAt: localFile.stat.mtime,
						status: "conflicted",
					};
					result.conflicts++;
				} catch (e) {
					console.error(`Remote Vault Sync: conflict handling failed for ${remotePath}`, e);
					result.errors++;
				}
			} else if (remoteChanged && !isLocallyChanged) {
				// Remote changed, local untouched — pull
				onProgress?.(`Pulling: ${remotePath}`);
				try {
					await pullFile(app, settings, syncFolder, remotePath, result, "updated");
					fileStates[remotePath] = {
						remoteSyncedAt: remoteEntry.updatedAt,
						localModifiedAt: Date.now(),
						status: "synced",
					};
				} catch (e) {
					console.error(`Remote Vault Sync: pull failed for ${remotePath}`, e);
					result.errors++;
				}
			} else if (!remoteChanged && isLocallyChanged) {
				// Local changed, remote untouched — push
				onProgress?.(`Pushing: ${remotePath}`);
				try {
					await pushFile(app, settings, syncFolder, remotePath, localFile);
					fileStates[remotePath] = {
						remoteSyncedAt: new Date().toISOString(),
						localModifiedAt: localFile.stat.mtime,
						status: "synced",
					};
					result.pushed++;
				} catch (e) {
					console.error(`Remote Vault Sync: push failed for ${remotePath}`, e);
					result.errors++;
				}
			} else {
				// Neither changed — ensure state exists
				if (!state) {
					fileStates[remotePath] = {
						remoteSyncedAt: remoteEntry.updatedAt,
						localModifiedAt: localFile.stat.mtime,
						status: "synced",
					};
				}
			}
		}
	}

	// 3. Process local-only files (exist locally but not on remote)
	for (const [relPath, localFile] of localFileMap) {
		if (processedPaths.has(relPath)) continue;
		if (isConflictFile(relPath)) continue;

		const state = fileStates[relPath];

		if (state && !remoteMap.has(relPath)) {
			// Was synced before, now gone from remote
			if (localChangedPaths.has(relPath)) {
				// Local modified, remote deleted — conflict: keep local, warn
				onProgress?.(`Conflict (deleted remotely, changed locally): ${relPath}`);
				fileStates[relPath] = {
					...state,
					status: "conflicted",
				};
				result.conflicts++;
			} else {
				// Local untouched, remote deleted — delete local
				onProgress?.(`Deleting local (removed from server): ${relPath}`);
				try {
					await app.vault.delete(localFile);
					delete fileStates[relPath];
					result.deleted++;
				} catch (e) {
					console.error(`Remote Vault Sync: local delete failed for ${relPath}`, e);
					result.errors++;
				}
			}
		} else if (!state) {
			// New local file, doesn't exist on server — push
			onProgress?.(`Pushing new: ${relPath}`);
			try {
				await pushFile(app, settings, syncFolder, relPath, localFile);
				fileStates[relPath] = {
					remoteSyncedAt: new Date().toISOString(),
					localModifiedAt: localFile.stat.mtime,
					status: "synced",
				};
				result.pushed++;
			} catch (e) {
				console.error(`Remote Vault Sync: push failed for ${relPath}`, e);
				result.errors++;
			}
		}
	}

	// 4. Handle queued deletes for paths not on remote (already deleted on both sides)
	for (const delPath of localDeletedPaths) {
		if (!processedPaths.has(delPath) && fileStates[delPath]) {
			delete fileStates[delPath];
		}
	}

	// Clean up empty folders
	await cleanEmptyFolders(app, syncFolder);

	// Clean up file states for paths that no longer exist anywhere
	for (const path of Object.keys(fileStates)) {
		if (!remoteMap.has(path) && !localFileMap.has(path)) {
			delete fileStates[path];
		}
	}

	const newLastSync = new Date().toISOString();
	return { result, newLastSync, fileStates };
}

/**
 * Pull a single file from the remote server and write it locally.
 */
async function pullFile(
	app: App,
	settings: RemoteVaultSyncSettings,
	syncFolder: string,
	remotePath: string,
	result: SyncResult,
	countField: "created" | "updated"
): Promise<void> {
	const file = await readFile(
		settings.apiUrl,
		settings.apiToken,
		remotePath
	);

	const localPath = normalizePath(`${syncFolder}/${remotePath}`);
	const parentPath = localPath.substring(0, localPath.lastIndexOf("/"));
	if (parentPath) {
		await ensureFolder(app, parentPath);
	}

	const existing = app.vault.getAbstractFileByPath(localPath);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, file.content);
		result[countField]++;
	} else {
		await app.vault.create(localPath, file.content);
		result[countField]++;
	}
}

/**
 * Push a local file to the remote server.
 */
async function pushFile(
	app: App,
	settings: RemoteVaultSyncSettings,
	syncFolder: string,
	relativePath: string,
	localFile: TFile
): Promise<void> {
	const content = await app.vault.read(localFile);
	await writeFile(
		settings.apiUrl,
		settings.apiToken,
		relativePath,
		content
	);
}

/**
 * Handle a conflict: save the remote version as .conflict.md and
 * prepend a banner to the local file.
 */
async function createConflict(
	app: App,
	settings: RemoteVaultSyncSettings,
	syncFolder: string,
	remotePath: string,
	localFile: TFile
): Promise<void> {
	// Fetch the remote version
	const remoteFile = await readFile(
		settings.apiUrl,
		settings.apiToken,
		remotePath
	);

	// Create the conflict file with remote content
	const conflictRelPath = toConflictPath(remotePath);
	const conflictLocalPath = normalizePath(`${syncFolder}/${conflictRelPath}`);

	const parentPath = conflictLocalPath.substring(
		0,
		conflictLocalPath.lastIndexOf("/")
	);
	if (parentPath) {
		await ensureFolder(app, parentPath);
	}

	const existingConflict = app.vault.getAbstractFileByPath(conflictLocalPath);
	if (existingConflict instanceof TFile) {
		await app.vault.modify(existingConflict, remoteFile.content);
	} else {
		await app.vault.create(conflictLocalPath, remoteFile.content);
	}

	// Prepend conflict banner to local file (if not already present)
	const localContent = await app.vault.read(localFile);
	if (!localContent.startsWith("> [!danger] CONFLICT:")) {
		const banner = CONFLICT_BANNER.replace(
			"%CONFLICT_PATH%",
			conflictRelPath
		);
		await app.vault.modify(localFile, banner + localContent);
	}
}

/**
 * Get the conflict file path for a given file path.
 * e.g. "inbox.md" -> "inbox.conflict.md"
 */
function toConflictPath(path: string): string {
	const lastDot = path.lastIndexOf(".");
	if (lastDot === -1) return path + CONFLICT_SUFFIX;
	return path.substring(0, lastDot) + CONFLICT_SUFFIX;
}

/**
 * Check if a path is a conflict file.
 */
export function isConflictFile(path: string): boolean {
	return path.endsWith(CONFLICT_SUFFIX);
}

/**
 * Convert an absolute vault path to a path relative to the sync folder.
 * Returns null if the path is outside the sync folder.
 */
function toRelativePath(
	absolutePath: string,
	syncFolder: string
): string | null {
	const normalized = normalizePath(absolutePath);
	const prefix = syncFolder + "/";
	if (!normalized.startsWith(prefix)) return null;
	return normalized.slice(prefix.length);
}

/**
 * Count the number of conflicted files in the sync state.
 */
export function countConflicts(fileStates: SyncStateMap): number {
	let count = 0;
	for (const path of Object.keys(fileStates)) {
		if (fileStates[path].status === "conflicted") {
			count++;
		}
	}
	return count;
}

/**
 * Check if a previously conflicted file has been resolved.
 * A conflict is resolved when the .conflict.md file has been deleted.
 */
export function checkConflictResolved(
	app: App,
	syncFolder: string,
	relativePath: string
): boolean {
	const conflictRelPath = toConflictPath(relativePath);
	const conflictLocalPath = normalizePath(
		`${syncFolder}/${conflictRelPath}`
	);
	const conflictFile = app.vault.getAbstractFileByPath(conflictLocalPath);
	return !(conflictFile instanceof TFile);
}

/**
 * Resolve conflicts that have been manually handled (conflict file deleted).
 * Strips the conflict banner from the local file and updates status.
 */
export async function resolveConflicts(
	app: App,
	syncFolder: string,
	fileStates: SyncStateMap
): Promise<number> {
	let resolved = 0;
	const folder = normalizePath(syncFolder);

	for (const [relPath, state] of Object.entries(fileStates)) {
		if (state.status !== "conflicted") continue;

		if (checkConflictResolved(app, folder, relPath)) {
			// Conflict file is gone — user resolved it
			const localPath = normalizePath(`${folder}/${relPath}`);
			const localFile = app.vault.getAbstractFileByPath(localPath);

			if (localFile instanceof TFile) {
				// Strip conflict banner if present
				const content = await app.vault.read(localFile);
				const bannerEnd = content.indexOf("\n\n");
				if (
					content.startsWith("> [!danger] CONFLICT:") &&
					bannerEnd !== -1
				) {
					const cleaned = content.slice(bannerEnd + 2);
					await app.vault.modify(localFile, cleaned);
				}
				state.status = "synced";
				state.localModifiedAt = Date.now();
				resolved++;
			} else {
				// Local file also gone — clean up state
				delete fileStates[relPath];
				resolved++;
			}
		}
	}
	return resolved;
}

// --- Utility functions ---

async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const normalized = normalizePath(folderPath);
	const existing = app.vault.getAbstractFileByPath(normalized);
	if (existing instanceof TFolder) return;
	if (existing) {
		throw new Error(
			`Cannot create folder "${normalized}" - a file exists at that path`
		);
	}
	await app.vault.createFolder(normalized);
}

function getLocalFiles(app: App, folderPath: string): TFile[] {
	const folder = app.vault.getAbstractFileByPath(folderPath);
	if (!(folder instanceof TFolder)) return [];
	const files: TFile[] = [];
	collectFiles(folder, files);
	return files;
}

function collectFiles(folder: TFolder, result: TFile[]): void {
	for (const child of folder.children) {
		if (child instanceof TFile) {
			result.push(child);
		} else if (child instanceof TFolder) {
			collectFiles(child, result);
		}
	}
}

async function cleanEmptyFolders(
	app: App,
	syncFolder: string
): Promise<void> {
	const folder = app.vault.getAbstractFileByPath(syncFolder);
	if (!(folder instanceof TFolder)) return;
	await cleanFolderRecursive(app, folder, syncFolder);
}

async function cleanFolderRecursive(
	app: App,
	folder: TFolder,
	syncRoot: string
): Promise<boolean> {
	const childFolders = folder.children.filter(
		(c) => c instanceof TFolder
	) as TFolder[];
	for (const child of childFolders) {
		await cleanFolderRecursive(app, child, syncRoot);
	}
	if (folder.path === syncRoot) return false;
	if (folder.children.length === 0) {
		await app.vault.delete(folder);
		return true;
	}
	return false;
}
