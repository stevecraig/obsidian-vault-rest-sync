import { ItemView, WorkspaceLeaf, TFile, normalizePath } from "obsidian";
import {
	SyncEvent,
	SyncEventType,
	EVENT_ICONS,
	EVENT_LABELS,
	formatRelativeTime,
} from "./activity-types";

export const VIEW_TYPE_SYNC_ACTIVITY = "remote-vault-sync-activity";

/**
 * Groups events by their cycle ID for display purposes.
 */
interface EventGroup {
	cycleId: string;
	timestamp: string;
	events: SyncEvent[];
}

/**
 * Sync Activity Feed view — shows a chronological log of sync events
 * grouped by sync cycle, with clickable file names and relative timestamps.
 */
export class SyncActivityView extends ItemView {
	private events: SyncEvent[] = [];
	private lastSyncTime: string | null = null;
	private nextSyncSeconds: number | null = null;
	private syncFolder: string = "Remote Vault";
	private countdownTimer: ReturnType<typeof setInterval> | null = null;
	private styleEl: HTMLStyleElement | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_SYNC_ACTIVITY;
	}

	getDisplayText(): string {
		return "Sync Activity";
	}

	getIcon(): string {
		return "activity";
	}

	async onOpen(): Promise<void> {
		this.injectStyles();
		this.render();
		// Refresh relative timestamps every 30 seconds
		this.countdownTimer = setInterval(() => this.render(), 30000);
	}

	async onClose(): Promise<void> {
		if (this.countdownTimer !== null) {
			clearInterval(this.countdownTimer);
			this.countdownTimer = null;
		}
		// Only remove shared style if no other activity views are open
		if (this.styleEl) {
			const otherViews = this.app.workspace.getLeavesOfType(VIEW_TYPE_SYNC_ACTIVITY)
				.filter((l) => l.view !== this);
			if (otherViews.length === 0) {
				this.styleEl.remove();
			}
			this.styleEl = null;
		}
	}

	/**
	 * Batch-update all view data and render once.
	 */
	update(data: {
		events: SyncEvent[];
		syncFolder: string;
		lastSync: string | null;
		nextSyncSeconds: number | null;
	}): void {
		this.events = data.events;
		this.syncFolder = data.syncFolder;
		this.lastSyncTime = data.lastSync;
		this.nextSyncSeconds = data.nextSyncSeconds;
		this.render();
	}

	/**
	 * Render the full activity feed.
	 */
	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		if (!container) return;
		container.empty();
		container.addClass("rvs-activity-container");

		if (this.events.length === 0) {
			const empty = container.createDiv({ cls: "rvs-activity-empty" });
			empty.createEl("p", { text: "No sync activity yet." });
			empty.createEl("p", {
				text: "Run a sync to see events here.",
				cls: "rvs-activity-hint",
			});
			this.renderFooter(container);
			return;
		}

		// Group events by cycle, newest first
		const groups = this.groupByCycle(this.events);

		const listEl = container.createDiv({ cls: "rvs-activity-list" });

		for (const group of groups) {
			this.renderGroup(listEl, group);
		}

		this.renderFooter(container);
	}

	/**
	 * Group events by sync cycle, ordered newest-first.
	 */
	private groupByCycle(events: SyncEvent[]): EventGroup[] {
		const groupMap = new Map<string, SyncEvent[]>();
		const groupOrder: string[] = [];

		// Iterate in reverse (newest first)
		for (let i = events.length - 1; i >= 0; i--) {
			const event = events[i];
			if (!groupMap.has(event.cycleId)) {
				groupMap.set(event.cycleId, []);
				groupOrder.push(event.cycleId);
			}
			groupMap.get(event.cycleId)!.push(event);
		}

		return groupOrder.map((cycleId) => {
			const cycleEvents = groupMap.get(cycleId)!;
			return {
				cycleId,
				timestamp: cycleEvents[0].timestamp,
				events: cycleEvents,
			};
		});
	}

	/**
	 * Render a single sync cycle group.
	 */
	private renderGroup(parent: HTMLElement, group: EventGroup): void {
		const groupEl = parent.createDiv({ cls: "rvs-activity-group" });

		// Group header with relative timestamp
		const header = groupEl.createDiv({ cls: "rvs-activity-group-header" });
		header.createSpan({
			text: formatRelativeTime(group.timestamp),
			cls: "rvs-activity-time",
		});

		const summary = this.summarizeGroup(group.events);
		header.createSpan({
			text: summary,
			cls: "rvs-activity-summary",
		});

		// Individual events
		for (const event of group.events) {
			this.renderEvent(groupEl, event);
		}
	}

	/**
	 * Render a single event row.
	 */
	private renderEvent(parent: HTMLElement, event: SyncEvent): void {
		const row = parent.createDiv({ cls: "rvs-activity-event" });
		row.addClass(`rvs-event-${event.type}`);

		// Icon
		const icon = row.createSpan({ cls: "rvs-activity-icon" });
		icon.setText(EVENT_ICONS[event.type]);

		// File name (clickable)
		const fileLink = row.createSpan({ cls: "rvs-activity-file" });
		fileLink.setText(event.path);
		fileLink.setAttribute("title", event.path);
		fileLink.addEventListener("click", () => {
			this.openFile(event.path);
		});

		// Event label
		row.createSpan({
			text: EVENT_LABELS[event.type],
			cls: `rvs-activity-label rvs-label-${event.type}`,
		});

		// Origin indicator
		if (event.origin) {
			row.createSpan({
				text: event.origin === "remote" ? "MCP" : "local",
				cls: `rvs-activity-origin rvs-origin-${event.origin}`,
			});
		}
	}

	/**
	 * Generate a short summary for a group (e.g. "3 pulled, 1 pushed").
	 */
	private summarizeGroup(events: SyncEvent[]): string {
		const counts: Partial<Record<SyncEventType, number>> = {};
		for (const e of events) {
			counts[e.type] = (counts[e.type] || 0) + 1;
		}

		const parts: string[] = [];
		const order: SyncEventType[] = [
			"pulled",
			"pushed",
			"conflict",
			"merged",
			"deleted",
			"resolved",
		];
		for (const type of order) {
			const count = counts[type];
			if (count && count > 0) {
				parts.push(`${count} ${type}`);
			}
		}
		return parts.join(", ");
	}

	/**
	 * Open a file in the workspace.
	 */
	private openFile(relativePath: string): void {
		const syncFolder = normalizePath(this.syncFolder);
		const fullPath = normalizePath(`${syncFolder}/${relativePath}`);
		const file = this.app.vault.getAbstractFileByPath(fullPath);

		if (file instanceof TFile) {
			const leaf = this.app.workspace.getLeaf(false);
			leaf.openFile(file);
		}
	}

	/**
	 * Render the footer with last sync time and countdown.
	 */
	private renderFooter(container: HTMLElement): void {
		const footer = container.createDiv({ cls: "rvs-activity-footer" });

		if (this.lastSyncTime) {
			footer.createSpan({
				text: `Last sync: ${formatRelativeTime(this.lastSyncTime)}`,
				cls: "rvs-activity-footer-text",
			});
		} else {
			footer.createSpan({
				text: "No syncs completed",
				cls: "rvs-activity-footer-text",
			});
		}

		if (this.nextSyncSeconds !== null && this.nextSyncSeconds > 0) {
			const minutes = Math.ceil(this.nextSyncSeconds / 60);
			footer.createSpan({
				text: ` \u00B7 Next in ${minutes} min`,
				cls: "rvs-activity-footer-next",
			});
		}
	}

	/**
	 * Inject styles for the activity feed.
	 */
	private injectStyles(): void {
		// Reuse existing shared style element if present
		const existing = document.getElementById("rvs-activity-styles") as HTMLStyleElement | null;
		if (existing) {
			this.styleEl = existing;
			return;
		}

		this.styleEl = document.createElement("style");
		this.styleEl.id = "rvs-activity-styles";
		this.styleEl.textContent = `
.rvs-activity-container {
	padding: 0;
	height: 100%;
	display: flex;
	flex-direction: column;
}

.rvs-activity-empty {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	padding: 40px 20px;
	color: var(--text-muted);
	text-align: center;
	flex: 1;
}

.rvs-activity-empty p {
	margin: 4px 0;
}

.rvs-activity-hint {
	font-size: 0.85em;
	opacity: 0.7;
}

.rvs-activity-list {
	flex: 1;
	overflow-y: auto;
	padding: 8px 0;
}

.rvs-activity-group {
	margin-bottom: 4px;
}

.rvs-activity-group-header {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 12px;
	background: var(--background-secondary);
	border-bottom: 1px solid var(--background-modifier-border);
	font-size: 0.8em;
	color: var(--text-muted);
	position: sticky;
	top: 0;
	z-index: 1;
}

.rvs-activity-time {
	font-weight: 600;
	color: var(--text-normal);
}

.rvs-activity-summary {
	margin-left: auto;
	opacity: 0.8;
}

.rvs-activity-event {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 12px 4px 20px;
	font-size: 0.85em;
	cursor: default;
}

.rvs-activity-event:hover {
	background: var(--background-modifier-hover);
}

.rvs-activity-icon {
	flex-shrink: 0;
	width: 18px;
	text-align: center;
	font-size: 0.9em;
}

.rvs-event-conflict .rvs-activity-icon,
.rvs-event-conflict .rvs-activity-label {
	color: var(--text-error);
}

.rvs-event-pulled .rvs-activity-icon {
	color: var(--text-accent);
}

.rvs-event-pushed .rvs-activity-icon {
	color: var(--text-accent);
}

.rvs-event-deleted .rvs-activity-icon {
	color: var(--text-muted);
}

.rvs-event-resolved .rvs-activity-icon,
.rvs-event-resolved .rvs-activity-label {
	color: var(--text-success, var(--interactive-success));
}

.rvs-event-merged .rvs-activity-icon {
	color: var(--text-accent);
}

.rvs-activity-file {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	cursor: pointer;
	color: var(--text-normal);
}

.rvs-activity-file:hover {
	color: var(--text-accent);
	text-decoration: underline;
}

.rvs-activity-label {
	flex-shrink: 0;
	font-size: 0.8em;
	color: var(--text-muted);
	text-transform: lowercase;
}

.rvs-activity-footer {
	padding: 8px 12px;
	border-top: 1px solid var(--background-modifier-border);
	font-size: 0.8em;
	color: var(--text-muted);
	background: var(--background-secondary);
	flex-shrink: 0;
}

.rvs-activity-footer-next {
	opacity: 0.7;
}

.rvs-activity-origin {
	flex-shrink: 0;
	font-size: 0.7em;
	padding: 1px 5px;
	border-radius: 3px;
	font-weight: 500;
	text-transform: uppercase;
	letter-spacing: 0.03em;
}

.rvs-origin-remote {
	background: var(--text-accent);
	color: var(--background-primary);
	opacity: 0.85;
}

.rvs-origin-local {
	background: var(--background-modifier-border);
	color: var(--text-muted);
}
`;
		document.head.appendChild(this.styleEl);
	}
}
