import { Plugin, normalizePath } from "obsidian";
import type { SyncStateMap, FileSyncStatus } from "./sync";

/**
 * Badge configuration for each sync status that warrants a visual indicator.
 */
interface BadgeConfig {
	text: string;
	tooltip: string;
	cssClass: string;
}

const BADGE_MAP: Record<string, BadgeConfig> = {
	pendingPush: {
		text: "\u2191", // ↑
		tooltip: "Local changes pending sync",
		cssClass: "rvs-badge-push",
	},
	pendingPull: {
		text: "\u2193", // ↓
		tooltip: "Remote update available",
		cssClass: "rvs-badge-pull",
	},
	conflicted: {
		text: "\u26A0", // ⚠
		tooltip: "Conflict \u2014 resolve before syncing",
		cssClass: "rvs-badge-conflict",
	},
};

/**
 * Manages sync status badges in the file explorer.
 *
 * Uses a dynamic <style> element with CSS ::after pseudo-elements to show
 * badges on file explorer items. This approach avoids depending on
 * undocumented internal APIs and works across Obsidian versions.
 */
export class SyncDecorator {
	private plugin: Plugin;
	private syncFolder: string;
	private styleEl: HTMLStyleElement | null = null;
	private currentStates: Map<string, FileSyncStatus> = new Map();

	constructor(plugin: Plugin, syncFolder: string) {
		this.plugin = plugin;
		this.syncFolder = syncFolder;
	}

	/**
	 * Register the decorator — injects the base stylesheet and
	 * sets up a layout-change listener to re-apply badges when the
	 * file explorer is rebuilt.
	 */
	register(): void {
		this.injectBaseStyles();

		// Re-apply badges when the workspace layout changes (e.g. file explorer refresh)
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("layout-change", () => {
				this.applyStyles();
			})
		);
	}

	/**
	 * Update decoration state with the latest sync info.
	 *
	 * @param fileStates - The full sync state map (relative paths)
	 * @param changeQueue - Absolute paths of files with pending local changes
	 */
	updateDecorations(
		fileStates: SyncStateMap,
		changeQueue: string[]
	): void {
		this.currentStates.clear();
		const syncPrefix = normalizePath(this.syncFolder) + "/";

		// Build a set of relative paths from the change queue
		const pendingPaths = new Set<string>();
		for (const absPath of changeQueue) {
			const normalized = normalizePath(absPath);
			if (normalized.startsWith(syncPrefix)) {
				pendingPaths.add(normalized.slice(syncPrefix.length));
			}
		}

		// Populate current states from fileStates
		for (const [relPath, state] of Object.entries(fileStates)) {
			if (state.status === "conflicted") {
				this.currentStates.set(relPath, "conflicted");
			} else if (state.status === "pendingPull") {
				this.currentStates.set(relPath, "pendingPull");
			} else if (pendingPaths.has(relPath)) {
				// File is in the change queue — mark as pending push
				this.currentStates.set(relPath, "pendingPush");
			}
			// "synced" files with no pending changes get no badge
		}

		// Also mark files from the change queue that may not be in fileStates yet
		for (const relPath of pendingPaths) {
			if (!this.currentStates.has(relPath)) {
				this.currentStates.set(relPath, "pendingPush");
			}
		}

		this.applyStyles();
	}

	/**
	 * Remove all decorations and clean up the style element.
	 */
	destroy(): void {
		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = null;
		}
		this.currentStates.clear();
	}

	/**
	 * Update the sync folder (e.g. when settings change).
	 */
	setSyncFolder(syncFolder: string): void {
		this.syncFolder = syncFolder;
	}

	/**
	 * Inject the base CSS for badge styling.
	 * The actual per-file rules are generated dynamically.
	 */
	private injectBaseStyles(): void {
		if (this.styleEl) return;

		this.styleEl = document.createElement("style");
		this.styleEl.id = "rvs-sync-decorations";
		document.head.appendChild(this.styleEl);
	}

	/**
	 * Generate and apply CSS rules for all current badge states.
	 *
	 * Each file gets a rule like:
	 *   .nav-file-title[data-path="SyncFolder/file.md"]::after { content: "↑"; ... }
	 */
	private applyStyles(): void {
		if (!this.styleEl) return;

		const syncPrefix = normalizePath(this.syncFolder);
		const rules: string[] = [];

		// Base styling for all badges
		rules.push(`
.nav-file-title .rvs-sync-badge {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	margin-left: 4px;
	font-size: 10px;
	width: 16px;
	height: 16px;
	border-radius: 50%;
	flex-shrink: 0;
}
.rvs-badge-push {
	color: var(--text-accent);
}
.rvs-badge-pull {
	color: var(--text-accent);
}
.rvs-badge-conflict {
	color: var(--text-error);
}
`);

		for (const [relPath, status] of this.currentStates) {
			const badge = BADGE_MAP[status];
			if (!badge) continue;

			const fullPath = syncPrefix + "/" + relPath;
			// Escape CSS special chars in the path
			const escapedPath = this.cssEscape(fullPath);

			rules.push(
				`.nav-file-title[data-path="${escapedPath}"]::after {` +
				` content: "${badge.text}";` +
				` display: inline-flex;` +
				` align-items: center;` +
				` justify-content: center;` +
				` margin-left: 4px;` +
				` font-size: 10px;` +
				` flex-shrink: 0;` +
				` color: ${status === "conflicted" ? "var(--text-error)" : "var(--text-accent)"};` +
				` }`
			);
		}

		this.styleEl.textContent = rules.join("\n");
	}

	/**
	 * Escape a string for use inside a CSS attribute selector value.
	 */
	private cssEscape(value: string): string {
		return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	}
}
