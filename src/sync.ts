import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { listFiles, readFile, FileListEntry, ApiError } from "./api";
import type { RemoteVaultSyncSettings } from "./settings";

const BANNER =
	"> [!warning] This file is managed by Remote Vault Sync. Local changes will be overwritten.\n\n";

export interface SyncResult {
	created: number;
	updated: number;
	deleted: number;
	errors: number;
}

/**
 * Perform a full sync: pull remote files into the sync folder,
 * delete local files that no longer exist on the server.
 */
export async function performSync(
	app: App,
	settings: RemoteVaultSyncSettings,
	lastSync: string | null,
	onProgress?: (msg: string) => void
): Promise<{ result: SyncResult; newLastSync: string }> {
	if (!settings.apiUrl || !settings.apiToken) {
		throw new Error("API URL and token must be configured in settings");
	}

	const result: SyncResult = {
		created: 0,
		updated: 0,
		deleted: 0,
		errors: 0,
	};

	const syncFolder = normalizePath(settings.syncFolder);

	// Ensure sync folder exists
	await ensureFolder(app, syncFolder);

	// Fetch full file list (always fetch all for deletion detection)
	onProgress?.("Fetching file list...");
	let remoteFiles: FileListEntry[];
	try {
		remoteFiles = await listFiles(
			settings.apiUrl,
			settings.apiToken
		);
	} catch (e) {
		if (e instanceof ApiError) {
			throw new Error(`Failed to list files: ${e.message}`);
		}
		throw e;
	}

	// Build a map of remote paths for deletion detection
	const remotePaths = new Set(remoteFiles.map((f) => f.path));

	// Build a map of local files in sync folder
	const localFiles = getLocalFiles(app, syncFolder);
	const localMap = new Map<string, TFile>();
	for (const file of localFiles) {
		// Strip sync folder prefix to get relative path
		const relativePath = file.path.slice(syncFolder.length + 1);
		localMap.set(relativePath, file);
	}

	// Determine which files need to be fetched
	const toFetch: FileListEntry[] = [];
	for (const remote of remoteFiles) {
		const localFile = localMap.get(remote.path);
		if (!localFile) {
			// New file
			toFetch.push(remote);
		} else {
			// Check if remote is newer
			const remoteUpdated = new Date(remote.updatedAt).getTime();
			// Use the file's mtime as a proxy; we also store updatedAt in the banner
			// but for simplicity compare with mtime
			if (remoteUpdated > localFile.stat.mtime) {
				toFetch.push(remote);
			}
		}
	}

	// Fetch and write files
	for (const entry of toFetch) {
		try {
			onProgress?.(`Syncing ${entry.path}...`);
			const file = await readFile(
				settings.apiUrl,
				settings.apiToken,
				entry.path
			);

			const localPath = normalizePath(`${syncFolder}/${entry.path}`);

			// Ensure parent folders exist
			const parentPath = localPath.substring(
				0,
				localPath.lastIndexOf("/")
			);
			if (parentPath) {
				await ensureFolder(app, parentPath);
			}

			const content = BANNER + file.content;
			const existing = app.vault.getAbstractFileByPath(localPath);

			if (existing instanceof TFile) {
				await app.vault.modify(existing, content);
				result.updated++;
			} else {
				await app.vault.create(localPath, content);
				result.created++;
			}
		} catch (e) {
			console.error(
				`Remote Vault Sync: failed to sync ${entry.path}`,
				e
			);
			result.errors++;
		}
	}

	// Delete local files that no longer exist on server
	for (const [relativePath, localFile] of localMap) {
		if (!remotePaths.has(relativePath)) {
			try {
				onProgress?.(`Removing ${relativePath}...`);
				await app.vault.delete(localFile);
				result.deleted++;
			} catch (e) {
				console.error(
					`Remote Vault Sync: failed to delete ${relativePath}`,
					e
				);
				result.errors++;
			}
		}
	}

	// Clean up empty folders in sync directory
	await cleanEmptyFolders(app, syncFolder);

	const newLastSync = new Date().toISOString();

	return { result, newLastSync };
}

/**
 * Ensure a folder path exists in the vault, creating intermediate folders as needed.
 */
async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const normalized = normalizePath(folderPath);
	const existing = app.vault.getAbstractFileByPath(normalized);
	if (existing instanceof TFolder) {
		return;
	}
	if (existing) {
		// A file exists at this path — can't create folder
		throw new Error(
			`Cannot create folder "${normalized}" — a file exists at that path`
		);
	}
	await app.vault.createFolder(normalized);
}

/**
 * Get all files within a folder path (recursively).
 */
function getLocalFiles(app: App, folderPath: string): TFile[] {
	const folder = app.vault.getAbstractFileByPath(folderPath);
	if (!(folder instanceof TFolder)) {
		return [];
	}
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

/**
 * Remove empty folders within the sync directory (bottom-up).
 */
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
	// Process children first (bottom-up)
	const childFolders = folder.children.filter(
		(c) => c instanceof TFolder
	) as TFolder[];
	for (const child of childFolders) {
		await cleanFolderRecursive(app, child, syncRoot);
	}

	// Don't delete the sync root itself
	if (folder.path === syncRoot) return false;

	// If folder is now empty, delete it
	if (folder.children.length === 0) {
		await app.vault.delete(folder);
		return true;
	}
	return false;
}
