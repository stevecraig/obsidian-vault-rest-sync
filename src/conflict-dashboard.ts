import { ItemView, WorkspaceLeaf, TFile, Notice } from "obsidian";
import { writeFile, readFile } from "./api";
import { sha256, SyncStateMap } from "./sync";
import { gatherConflicts, ConflictInfo, ConflictCallbacks } from "./conflict-ui";
import { formatRelativeTime } from "./activity-types";

export const VIEW_TYPE_CONFLICT_DASHBOARD = "remote-vault-sync-conflicts";

/**
 * Conflict Dashboard view — lists all conflicted files with
 * per-file resolution actions and bulk resolve options.
 */
export class ConflictDashboardView extends ItemView {
	private fileStates: SyncStateMap = {};
	private syncFolder: string = "Remote Vault";
	private callbacks: ConflictCallbacks | null = null;
	private styleEl: HTMLStyleElement | null = null;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CONFLICT_DASHBOARD;
	}

	getDisplayText(): string {
		return "Sync Conflicts";
	}

	getIcon(): string {
		return "alert-triangle";
	}

	async onOpen(): Promise<void> {
		this.injectStyles();
		this.render();
		// Refresh relative timestamps every 30 seconds
		this.refreshTimer = setInterval(() => this.render(), 30000);
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer !== null) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		if (this.styleEl) {
			const otherViews = this.app.workspace
				.getLeavesOfType(VIEW_TYPE_CONFLICT_DASHBOARD)
				.filter((l) => l.view !== this);
			if (otherViews.length === 0) {
				this.styleEl.remove();
			}
			this.styleEl = null;
		}
	}

	/**
	 * Update the dashboard with current data and re-render.
	 */
	update(data: {
		fileStates: SyncStateMap;
		syncFolder: string;
		callbacks: ConflictCallbacks;
	}): void {
		this.fileStates = data.fileStates;
		this.syncFolder = data.syncFolder;
		this.callbacks = data.callbacks;
		this.render();
	}

	/**
	 * Render the full conflict dashboard.
	 */
	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		if (!container) return;
		container.empty();
		container.addClass("rvs-conflicts-container");

		const conflicts = gatherConflicts(
			this.app,
			this.syncFolder,
			this.fileStates
		);

		if (conflicts.length === 0) {
			this.renderEmptyState(container);
			return;
		}

		// Header
		const header = container.createDiv({ cls: "rvs-conflicts-header" });
		header.createSpan({
			text: `Conflicts (${conflicts.length})`,
			cls: "rvs-conflicts-title",
		});

		// Conflict list
		const listEl = container.createDiv({ cls: "rvs-conflicts-list" });
		for (const conflict of conflicts) {
			this.renderConflictRow(listEl, conflict);
		}

		// Bulk actions
		if (conflicts.length > 1) {
			this.renderBulkActions(container, conflicts);
		}
	}

	/**
	 * Render the empty state when no conflicts exist.
	 */
	private renderEmptyState(container: HTMLElement): void {
		const empty = container.createDiv({ cls: "rvs-conflicts-empty" });
		empty.createSpan({
			text: "\u2713",
			cls: "rvs-conflicts-empty-icon",
		});
		empty.createEl("p", {
			text: "No conflicts \u2014 all synced",
			cls: "rvs-conflicts-empty-text",
		});
	}

	/**
	 * Render a single conflict row with metadata and action buttons.
	 */
	private renderConflictRow(
		parent: HTMLElement,
		conflict: ConflictInfo
	): void {
		const state = this.fileStates[conflict.remotePath];
		const row = parent.createDiv({ cls: "rvs-conflicts-row" });

		// File info section
		const infoSection = row.createDiv({ cls: "rvs-conflicts-info" });

		// File path header
		const pathRow = infoSection.createDiv({ cls: "rvs-conflicts-path-row" });
		pathRow.createSpan({
			text: "\u26A0",
			cls: "rvs-conflicts-warning-icon",
		});
		const pathLink = pathRow.createSpan({
			text: conflict.remotePath,
			cls: "rvs-conflicts-path",
		});
		pathLink.addEventListener("click", () => {
			this.openFile(conflict.localPath);
		});

		// Timestamps
		if (state) {
			const metaRow = infoSection.createDiv({ cls: "rvs-conflicts-meta" });
			if (state.localModifiedAt) {
				metaRow.createSpan({
					text: `Modified locally ${formatRelativeTime(new Date(state.localModifiedAt).toISOString())}`,
					cls: "rvs-conflicts-meta-item",
				});
			}
			if (state.remoteSyncedAt) {
				metaRow.createSpan({
					text: `Modified remotely ${formatRelativeTime(state.remoteSyncedAt)}`,
					cls: "rvs-conflicts-meta-item",
				});
			}
		}

		// Action buttons
		const actions = row.createDiv({ cls: "rvs-conflicts-actions" });

		const keepMineBtn = actions.createEl("button", {
			text: "Keep Mine",
			cls: "rvs-conflicts-btn rvs-conflicts-btn-mine",
		});
		keepMineBtn.addEventListener("click", () =>
			this.keepMine(conflict, keepMineBtn)
		);

		const keepTheirsBtn = actions.createEl("button", {
			text: "Keep Theirs",
			cls: "rvs-conflicts-btn rvs-conflicts-btn-theirs",
		});
		keepTheirsBtn.addEventListener("click", () =>
			this.keepTheirs(conflict, keepTheirsBtn)
		);

		const compareBtn = actions.createEl("button", {
			text: "Compare",
			cls: "rvs-conflicts-btn rvs-conflicts-btn-compare",
		});
		compareBtn.addEventListener("click", () => this.compare(conflict));
	}

	/**
	 * Render bulk resolution actions at the bottom.
	 */
	private renderBulkActions(
		container: HTMLElement,
		conflicts: ConflictInfo[]
	): void {
		const bulkSection = container.createDiv({ cls: "rvs-conflicts-bulk" });

		const bulkMineBtn = bulkSection.createEl("button", {
			text: "Resolve All: Keep Mine",
			cls: "rvs-conflicts-btn rvs-conflicts-bulk-btn rvs-conflicts-btn-mine",
		});
		bulkMineBtn.addEventListener("click", () =>
			this.resolveAll("mine", conflicts, bulkMineBtn)
		);

		const bulkTheirsBtn = bulkSection.createEl("button", {
			text: "Resolve All: Keep Theirs",
			cls: "rvs-conflicts-btn rvs-conflicts-bulk-btn rvs-conflicts-btn-theirs",
		});
		bulkTheirsBtn.addEventListener("click", () =>
			this.resolveAll("theirs", conflicts, bulkTheirsBtn)
		);
	}

	/**
	 * Keep Mine: push local version to remote, clean up conflict artifacts.
	 */
	private async keepMine(
		conflict: ConflictInfo,
		btn: HTMLButtonElement
	): Promise<void> {
		if (!this.callbacks) return;

		btn.disabled = true;
		btn.setText("Resolving...");

		try {
			const localFile = this.app.vault.getAbstractFileByPath(
				conflict.localPath
			);
			if (!(localFile instanceof TFile)) {
				new Notice("Local file not found");
				return;
			}

			const rawContent = await this.app.vault.read(localFile);
			const content = stripConflictBanner(rawContent);

			await writeFile(
				this.callbacks.apiUrl,
				this.callbacks.apiToken,
				conflict.remotePath,
				content
			);

			if (rawContent !== content) {
				await this.app.vault.modify(localFile, content);
			}

			await this.deleteConflictFile(conflict.conflictFilePath);

			const hash = await sha256(content);
			this.callbacks.fileStates[conflict.remotePath] = {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now(),
				status: "synced",
				remoteHash: hash,
				localHash: hash,
			};
			await this.callbacks.saveSettings();

			this.callbacks.onResolved(conflict.remotePath, {
				type: "resolved",
				path: conflict.remotePath,
				timestamp: new Date().toISOString(),
				cycleId: "",
			});

			new Notice(
				`Conflict resolved: kept local version of ${conflict.remotePath}`
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			new Notice(`Failed to resolve conflict: ${msg}`);
			console.error("Conflict resolution (keep mine) failed:", e);
		}

		this.render();
	}

	/**
	 * Keep Theirs: replace local file with remote version, clean up.
	 */
	private async keepTheirs(
		conflict: ConflictInfo,
		btn: HTMLButtonElement
	): Promise<void> {
		if (!this.callbacks) return;

		btn.disabled = true;
		btn.setText("Resolving...");

		try {
			const conflictFile = this.app.vault.getAbstractFileByPath(
				conflict.conflictFilePath
			);

			let remoteContent: string;

			if (conflictFile instanceof TFile) {
				remoteContent = await this.app.vault.read(conflictFile);
			} else {
				const fetched = await readFile(
					this.callbacks.apiUrl,
					this.callbacks.apiToken,
					conflict.remotePath
				);
				if (!fetched) {
					new Notice("Could not fetch remote version");
					return;
				}
				remoteContent = fetched.content;
			}

			const localFile = this.app.vault.getAbstractFileByPath(
				conflict.localPath
			);
			if (localFile instanceof TFile) {
				await this.app.vault.modify(localFile, remoteContent);
			}

			await writeFile(
				this.callbacks.apiUrl,
				this.callbacks.apiToken,
				conflict.remotePath,
				remoteContent
			);

			await this.deleteConflictFile(conflict.conflictFilePath);

			const hash = await sha256(remoteContent);
			this.callbacks.fileStates[conflict.remotePath] = {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now(),
				status: "synced",
				remoteHash: hash,
				localHash: hash,
			};
			await this.callbacks.saveSettings();

			this.callbacks.onResolved(conflict.remotePath, {
				type: "resolved",
				path: conflict.remotePath,
				timestamp: new Date().toISOString(),
				cycleId: "",
			});

			new Notice(
				`Conflict resolved: kept remote version of ${conflict.remotePath}`
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Unknown error";
			new Notice(`Failed to resolve conflict: ${msg}`);
			console.error("Conflict resolution (keep theirs) failed:", e);
		}

		this.render();
	}

	/**
	 * Compare: open local and conflict files side by side.
	 */
	private compare(conflict: ConflictInfo): void {
		const localFile = this.app.vault.getAbstractFileByPath(
			conflict.localPath
		);
		const conflictFile = this.app.vault.getAbstractFileByPath(
			conflict.conflictFilePath
		);

		if (localFile instanceof TFile) {
			const leftLeaf = this.app.workspace.getLeaf(false);
			leftLeaf.openFile(localFile);

			if (conflictFile instanceof TFile) {
				const rightLeaf = this.app.workspace.getLeaf("split");
				rightLeaf.openFile(conflictFile);
			}
		}

		new Notice(
			"Resolve manually, then delete the .conflict.md file to complete resolution."
		);
	}

	/**
	 * Resolve all conflicts with the same strategy.
	 */
	private async resolveAll(
		strategy: "mine" | "theirs",
		conflicts: ConflictInfo[],
		btn: HTMLButtonElement
	): Promise<void> {
		if (!this.callbacks) return;

		btn.disabled = true;
		btn.setText("Resolving all...");

		let resolved = 0;
		let failed = 0;

		for (const conflict of conflicts) {
			const state = this.callbacks.fileStates[conflict.remotePath];
			if (!state || state.status !== "conflicted") continue;

			try {
				if (strategy === "mine") {
					await this.resolveKeepMine(conflict);
				} else {
					await this.resolveKeepTheirs(conflict);
				}
				resolved++;
			} catch (e) {
				console.error(
					`Bulk resolve failed for ${conflict.remotePath}:`,
					e
				);
				failed++;
			}
		}

		if (failed > 0) {
			new Notice(
				`Resolved ${resolved} conflicts, ${failed} failed`
			);
		} else {
			new Notice(`Resolved all ${resolved} conflicts`);
		}

		this.render();
	}

	/**
	 * Internal resolve: keep mine (no UI updates, for bulk use).
	 */
	private async resolveKeepMine(conflict: ConflictInfo): Promise<void> {
		if (!this.callbacks) return;

		const localFile = this.app.vault.getAbstractFileByPath(
			conflict.localPath
		);
		if (!(localFile instanceof TFile)) return;

		const rawContent = await this.app.vault.read(localFile);
		const content = stripConflictBanner(rawContent);

		await writeFile(
			this.callbacks.apiUrl,
			this.callbacks.apiToken,
			conflict.remotePath,
			content
		);

		if (rawContent !== content) {
			await this.app.vault.modify(localFile, content);
		}

		await this.deleteConflictFile(conflict.conflictFilePath);

		const hash = await sha256(content);
		this.callbacks.fileStates[conflict.remotePath] = {
			remoteSyncedAt: new Date().toISOString(),
			localModifiedAt: Date.now(),
			status: "synced",
			remoteHash: hash,
			localHash: hash,
		};
		await this.callbacks.saveSettings();

		this.callbacks.onResolved(conflict.remotePath, {
			type: "resolved",
			path: conflict.remotePath,
			timestamp: new Date().toISOString(),
			cycleId: "",
		});
	}

	/**
	 * Internal resolve: keep theirs (no UI updates, for bulk use).
	 */
	private async resolveKeepTheirs(conflict: ConflictInfo): Promise<void> {
		if (!this.callbacks) return;

		const conflictFile = this.app.vault.getAbstractFileByPath(
			conflict.conflictFilePath
		);

		let remoteContent: string;

		if (conflictFile instanceof TFile) {
			remoteContent = await this.app.vault.read(conflictFile);
		} else {
			const fetched = await readFile(
				this.callbacks.apiUrl,
				this.callbacks.apiToken,
				conflict.remotePath
			);
			if (!fetched) return;
			remoteContent = fetched.content;
		}

		const localFile = this.app.vault.getAbstractFileByPath(
			conflict.localPath
		);
		if (localFile instanceof TFile) {
			await this.app.vault.modify(localFile, remoteContent);
		}

		await writeFile(
			this.callbacks.apiUrl,
			this.callbacks.apiToken,
			conflict.remotePath,
			remoteContent
		);

		await this.deleteConflictFile(conflict.conflictFilePath);

		const hash = await sha256(remoteContent);
		this.callbacks.fileStates[conflict.remotePath] = {
			remoteSyncedAt: new Date().toISOString(),
			localModifiedAt: Date.now(),
			status: "synced",
			remoteHash: hash,
			localHash: hash,
		};
		await this.callbacks.saveSettings();

		this.callbacks.onResolved(conflict.remotePath, {
			type: "resolved",
			path: conflict.remotePath,
			timestamp: new Date().toISOString(),
			cycleId: "",
		});
	}

	/**
	 * Delete the .conflict.md file if it exists.
	 */
	private async deleteConflictFile(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.delete(file);
		}
	}

	/**
	 * Open a file in the workspace.
	 */
	private openFile(path: string): void {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			const leaf = this.app.workspace.getLeaf(false);
			leaf.openFile(file);
		}
	}

	/**
	 * Inject scoped styles for the conflict dashboard.
	 */
	private injectStyles(): void {
		const existing = document.getElementById(
			"rvs-conflicts-dashboard-styles"
		) as HTMLStyleElement | null;
		if (existing) {
			this.styleEl = existing;
			return;
		}

		this.styleEl = document.createElement("style");
		this.styleEl.id = "rvs-conflicts-dashboard-styles";
		this.styleEl.textContent = `
.rvs-conflicts-container {
	padding: 0;
	height: 100%;
	display: flex;
	flex-direction: column;
}

.rvs-conflicts-header {
	padding: 12px 16px;
	border-bottom: 1px solid var(--background-modifier-border);
	background: var(--background-secondary);
	flex-shrink: 0;
}

.rvs-conflicts-title {
	font-size: 1.1em;
	font-weight: 600;
	color: var(--text-normal);
}

.rvs-conflicts-empty {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	padding: 40px 20px;
	color: var(--text-muted);
	text-align: center;
	flex: 1;
}

.rvs-conflicts-empty-icon {
	font-size: 2em;
	color: var(--text-success, var(--interactive-success));
	margin-bottom: 8px;
}

.rvs-conflicts-empty-text {
	font-size: 1em;
	margin: 0;
}

.rvs-conflicts-list {
	flex: 1;
	overflow-y: auto;
	padding: 8px 0;
}

.rvs-conflicts-row {
	padding: 12px 16px;
	border-bottom: 1px solid var(--background-modifier-border);
}

.rvs-conflicts-row:last-child {
	border-bottom: none;
}

.rvs-conflicts-info {
	margin-bottom: 8px;
}

.rvs-conflicts-path-row {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 4px;
}

.rvs-conflicts-warning-icon {
	color: var(--text-error);
	font-size: 1em;
	flex-shrink: 0;
}

.rvs-conflicts-path {
	font-weight: 500;
	word-break: break-word;
	cursor: pointer;
	color: var(--text-normal);
}

.rvs-conflicts-path:hover {
	color: var(--text-accent);
	text-decoration: underline;
}

.rvs-conflicts-meta {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding-left: 22px;
}

.rvs-conflicts-meta-item {
	font-size: 0.8em;
	color: var(--text-muted);
}

.rvs-conflicts-actions {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
	padding-left: 22px;
}

.rvs-conflicts-btn {
	padding: 4px 12px;
	border-radius: 4px;
	border: 1px solid var(--background-modifier-border);
	cursor: pointer;
	font-size: 0.85em;
	background: var(--interactive-normal);
	color: var(--text-normal);
}

.rvs-conflicts-btn:hover {
	background: var(--interactive-hover);
}

.rvs-conflicts-btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.rvs-conflicts-btn-mine {
	background: var(--interactive-accent);
	color: var(--text-on-accent);
	border-color: var(--interactive-accent);
}

.rvs-conflicts-btn-mine:hover {
	background: var(--interactive-accent-hover);
}

.rvs-conflicts-btn-theirs {
	background: var(--interactive-normal);
	border-color: var(--interactive-accent);
	color: var(--text-normal);
}

.rvs-conflicts-btn-compare {
	background: var(--interactive-normal);
	color: var(--text-normal);
}

.rvs-conflicts-bulk {
	padding: 12px 16px;
	border-top: 1px solid var(--background-modifier-border);
	background: var(--background-secondary);
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
	flex-shrink: 0;
}

.rvs-conflicts-bulk-btn {
	padding: 6px 16px;
	font-size: 0.9em;
}
`;
		document.head.appendChild(this.styleEl);
	}
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
