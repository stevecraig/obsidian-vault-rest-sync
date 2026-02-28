import { App, Modal, TFile, Notice, normalizePath } from "obsidian";
import { writeFile, readFile } from "./api";
import { sha256, SyncStateMap } from "./sync";
import type { SyncEvent } from "./activity-types";

/**
 * Information about a single conflict to resolve.
 */
export interface ConflictInfo {
	/** Relative path within the sync folder (remote path) */
	remotePath: string;
	/** Absolute local path of the conflicted file */
	localPath: string;
	/** Absolute local path of the .conflict.md file */
	conflictFilePath: string;
}

/**
 * Callback interface for conflict resolution actions.
 * The plugin passes these so the modal can update state and persist.
 */
export interface ConflictCallbacks {
	apiUrl: string;
	apiToken: string;
	syncFolder: string;
	fileStates: SyncStateMap;
	saveSettings: () => Promise<void>;
	onResolved: (remotePath: string, event: SyncEvent) => void;
}

/**
 * Gather all current conflicts from file states.
 * Returns an array of ConflictInfo for files that are still conflicted
 * and whose .conflict.md file still exists locally.
 */
export function gatherConflicts(
	app: App,
	syncFolder: string,
	fileStates: SyncStateMap
): ConflictInfo[] {
	const folder = normalizePath(syncFolder);
	const conflicts: ConflictInfo[] = [];

	for (const [remotePath, state] of Object.entries(fileStates)) {
		if (state.status !== "conflicted") continue;

		const localPath = normalizePath(`${folder}/${remotePath}`);
		const conflictRelPath = toConflictPath(remotePath);
		const conflictFilePath = normalizePath(`${folder}/${conflictRelPath}`);

		// Only show modal if the conflict file still exists
		const conflictFile = app.vault.getAbstractFileByPath(conflictFilePath);
		if (conflictFile instanceof TFile) {
			conflicts.push({ remotePath, localPath, conflictFilePath });
		}
	}

	return conflicts;
}

/**
 * Show conflict resolution modals sequentially for each conflict.
 */
export async function showConflictModals(
	app: App,
	conflicts: ConflictInfo[],
	callbacks: ConflictCallbacks
): Promise<void> {
	for (const conflict of conflicts) {
		// Check if still conflicted (may have been resolved by a previous action)
		const state = callbacks.fileStates[conflict.remotePath];
		if (!state || state.status !== "conflicted") continue;

		// Check if conflict file still exists
		const conflictFile = app.vault.getAbstractFileByPath(conflict.conflictFilePath);
		if (!(conflictFile instanceof TFile)) continue;

		await showSingleConflictModal(app, conflict, callbacks);
	}
}

/**
 * Show a single conflict resolution modal and wait for the user to act.
 */
function showSingleConflictModal(
	app: App,
	conflict: ConflictInfo,
	callbacks: ConflictCallbacks
): Promise<void> {
	return new Promise((resolve) => {
		const modal = new ConflictModal(app, conflict, callbacks, resolve);
		modal.open();
	});
}

/**
 * Strip the conflict banner from file content if present.
 * The banner starts with "> [!danger] CONFLICT:" and ends with a double newline.
 */
function stripConflictBanner(content: string): string {
	if (!content.startsWith("> [!danger] CONFLICT:")) {
		return content;
	}
	const bannerEnd = content.indexOf("\n\n");
	if (bannerEnd === -1) {
		return content;
	}
	return content.slice(bannerEnd + 2);
}

/**
 * Derive the .conflict.md path for a given file path.
 * e.g. "notes/idea.md" -> "notes/idea.conflict.md"
 */
function toConflictPath(path: string): string {
	const lastDot = path.lastIndexOf(".");
	if (lastDot === -1) return path + ".conflict.md";
	return path.substring(0, lastDot) + ".conflict.md";
}

/**
 * Modal for resolving a single file conflict.
 * Presents four actions: Keep Mine, Keep Theirs, Compare, Skip.
 */
class ConflictModal extends Modal {
	private conflict: ConflictInfo;
	private callbacks: ConflictCallbacks;
	private onDone: () => void;
	private styleEl: HTMLStyleElement | null = null;

	constructor(
		app: App,
		conflict: ConflictInfo,
		callbacks: ConflictCallbacks,
		onDone: () => void
	) {
		super(app);
		this.conflict = conflict;
		this.callbacks = callbacks;
		this.onDone = onDone;
	}

	onOpen(): void {
		this.injectStyles();

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("rvs-conflict-modal");

		// Header
		const header = contentEl.createDiv({ cls: "rvs-conflict-header" });
		header.createSpan({ text: "\u26A0", cls: "rvs-conflict-warning-icon" });
		header.createSpan({
			text: `Conflict: ${this.conflict.remotePath}`,
			cls: "rvs-conflict-title",
		});

		// Description
		contentEl.createEl("p", {
			text: "This file was changed both locally and on the server.",
			cls: "rvs-conflict-description",
		});

		// Action buttons
		const actions = contentEl.createDiv({ cls: "rvs-conflict-actions" });

		const keepMineBtn = actions.createEl("button", {
			text: "Keep Mine",
			cls: "rvs-conflict-btn rvs-conflict-btn-mine",
		});
		keepMineBtn.addEventListener("click", () => this.keepMine());

		const keepTheirsBtn = actions.createEl("button", {
			text: "Keep Theirs",
			cls: "rvs-conflict-btn rvs-conflict-btn-theirs",
		});
		keepTheirsBtn.addEventListener("click", () => this.keepTheirs());

		const compareBtn = actions.createEl("button", {
			text: "Compare",
			cls: "rvs-conflict-btn rvs-conflict-btn-compare",
		});
		compareBtn.addEventListener("click", () => this.compare());

		// Skip button in a separate row
		const skipRow = contentEl.createDiv({ cls: "rvs-conflict-skip-row" });
		const skipBtn = skipRow.createEl("button", {
			text: "Skip",
			cls: "rvs-conflict-btn rvs-conflict-btn-skip",
		});
		skipBtn.addEventListener("click", () => this.skip());
	}

	onClose(): void {
		// Clean up styles if no other conflict modals are open
		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = null;
		}
	}

	/**
	 * Keep Mine: push local version to remote, clean up conflict artifacts.
	 */
	private async keepMine(): Promise<void> {
		try {
			this.setLoading("Pushing local version...");

			const localFile = this.app.vault.getAbstractFileByPath(
				this.conflict.localPath
			);
			if (!(localFile instanceof TFile)) {
				new Notice("Local file not found");
				this.close();
				this.onDone();
				return;
			}

			// Read local content and strip the conflict banner
			const rawContent = await this.app.vault.read(localFile);
			const content = stripConflictBanner(rawContent);

			// Push to remote
			await writeFile(
				this.callbacks.apiUrl,
				this.callbacks.apiToken,
				this.conflict.remotePath,
				content
			);

			// Update local file (strip banner if present)
			if (rawContent !== content) {
				await this.app.vault.modify(localFile, content);
			}

			// Delete the .conflict.md file
			await this.deleteConflictFile();

			// Update file state
			const hash = await sha256(content);
			this.callbacks.fileStates[this.conflict.remotePath] = {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now(),
				status: "synced",
				remoteHash: hash,
				localHash: hash,
			};
			await this.callbacks.saveSettings();

			// Emit resolved event
			this.callbacks.onResolved(this.conflict.remotePath, {
				type: "resolved",
				path: this.conflict.remotePath,
				timestamp: new Date().toISOString(),
				cycleId: "",
			});

			new Notice(`Conflict resolved: kept local version of ${this.conflict.remotePath}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			new Notice(`Failed to resolve conflict: ${msg}`);
			console.error("Conflict resolution (keep mine) failed:", e);
		}

		this.close();
		this.onDone();
	}

	/**
	 * Keep Theirs: replace local file with remote version, clean up.
	 */
	private async keepTheirs(): Promise<void> {
		try {
			this.setLoading("Fetching remote version...");

			// Read the remote version from the .conflict.md file
			const conflictFile = this.app.vault.getAbstractFileByPath(
				this.conflict.conflictFilePath
			);

			let remoteContent: string;

			if (conflictFile instanceof TFile) {
				// Read from the local .conflict.md file (contains remote content)
				remoteContent = await this.app.vault.read(conflictFile);
			} else {
				// Fallback: fetch from API
				const fetched = await readFile(
					this.callbacks.apiUrl,
					this.callbacks.apiToken,
					this.conflict.remotePath
				);
				if (!fetched) {
					new Notice("Could not fetch remote version");
					this.close();
					this.onDone();
					return;
				}
				remoteContent = fetched.content;
			}

			// Replace local file content
			const localFile = this.app.vault.getAbstractFileByPath(
				this.conflict.localPath
			);
			if (localFile instanceof TFile) {
				await this.app.vault.modify(localFile, remoteContent);
			}

			// Push the accepted remote content to ensure consistency
			await writeFile(
				this.callbacks.apiUrl,
				this.callbacks.apiToken,
				this.conflict.remotePath,
				remoteContent
			);

			// Delete the .conflict.md file
			await this.deleteConflictFile();

			// Update file state
			const hash = await sha256(remoteContent);
			this.callbacks.fileStates[this.conflict.remotePath] = {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now(),
				status: "synced",
				remoteHash: hash,
				localHash: hash,
			};
			await this.callbacks.saveSettings();

			// Emit resolved event
			this.callbacks.onResolved(this.conflict.remotePath, {
				type: "resolved",
				path: this.conflict.remotePath,
				timestamp: new Date().toISOString(),
				cycleId: "",
			});

			new Notice(`Conflict resolved: kept remote version of ${this.conflict.remotePath}`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			new Notice(`Failed to resolve conflict: ${msg}`);
			console.error("Conflict resolution (keep theirs) failed:", e);
		}

		this.close();
		this.onDone();
	}

	/**
	 * Compare: open local and conflict files side by side.
	 * The user resolves manually; deleting .conflict.md triggers resolution
	 * on the next sync (existing behavior).
	 */
	private compare(): void {
		const localFile = this.app.vault.getAbstractFileByPath(
			this.conflict.localPath
		);
		const conflictFile = this.app.vault.getAbstractFileByPath(
			this.conflict.conflictFilePath
		);

		if (localFile instanceof TFile) {
			// Open local file in the current pane
			const leftLeaf = this.app.workspace.getLeaf(false);
			leftLeaf.openFile(localFile);

			// Open conflict file in a split pane
			if (conflictFile instanceof TFile) {
				const rightLeaf = this.app.workspace.getLeaf("split");
				rightLeaf.openFile(conflictFile);
			}
		}

		new Notice(
			"Resolve manually, then delete the .conflict.md file to complete resolution."
		);

		this.close();
		this.onDone();
	}

	/**
	 * Skip: close modal without resolving.
	 */
	private skip(): void {
		this.close();
		this.onDone();
	}

	/**
	 * Delete the .conflict.md file if it exists.
	 */
	private async deleteConflictFile(): Promise<void> {
		const conflictFile = this.app.vault.getAbstractFileByPath(
			this.conflict.conflictFilePath
		);
		if (conflictFile instanceof TFile) {
			await this.app.vault.delete(conflictFile);
		}
	}

	/**
	 * Show a loading state in the modal.
	 */
	private setLoading(message: string): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("rvs-conflict-modal");
		const loading = contentEl.createDiv({ cls: "rvs-conflict-loading" });
		loading.createSpan({ text: message });
	}

	/**
	 * Inject scoped styles for the conflict modal.
	 */
	private injectStyles(): void {
		const existing = document.getElementById("rvs-conflict-modal-styles") as HTMLStyleElement | null;
		if (existing) {
			this.styleEl = existing;
			return;
		}

		this.styleEl = document.createElement("style");
		this.styleEl.id = "rvs-conflict-modal-styles";
		this.styleEl.textContent = `
.rvs-conflict-modal {
	padding: 16px;
}

.rvs-conflict-header {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 12px;
}

.rvs-conflict-warning-icon {
	font-size: 1.4em;
	color: var(--text-error);
}

.rvs-conflict-title {
	font-size: 1.1em;
	font-weight: 600;
	word-break: break-word;
}

.rvs-conflict-description {
	color: var(--text-muted);
	margin-bottom: 16px;
}

.rvs-conflict-actions {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
	margin-bottom: 12px;
}

.rvs-conflict-btn {
	padding: 8px 16px;
	border-radius: 4px;
	border: 1px solid var(--background-modifier-border);
	cursor: pointer;
	font-size: 0.9em;
	background: var(--interactive-normal);
	color: var(--text-normal);
}

.rvs-conflict-btn:hover {
	background: var(--interactive-hover);
}

.rvs-conflict-btn-mine {
	background: var(--interactive-accent);
	color: var(--text-on-accent);
	border-color: var(--interactive-accent);
}

.rvs-conflict-btn-mine:hover {
	background: var(--interactive-accent-hover);
}

.rvs-conflict-btn-theirs {
	background: var(--interactive-normal);
	border-color: var(--interactive-accent);
	color: var(--text-normal);
}

.rvs-conflict-btn-compare {
	background: var(--interactive-normal);
	color: var(--text-normal);
}

.rvs-conflict-skip-row {
	display: flex;
	justify-content: flex-end;
}

.rvs-conflict-btn-skip {
	background: transparent;
	border-color: transparent;
	color: var(--text-muted);
	font-size: 0.85em;
	padding: 4px 12px;
}

.rvs-conflict-btn-skip:hover {
	color: var(--text-normal);
	background: var(--background-modifier-hover);
}

.rvs-conflict-loading {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
	color: var(--text-muted);
}
`;
		document.head.appendChild(this.styleEl);
	}
}
