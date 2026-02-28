/**
 * Types and storage helpers for the sync activity feed.
 */

/** Event types that can appear in the activity feed */
export type SyncEventType =
	| "pulled"
	| "pushed"
	| "conflict"
	| "merged"
	| "deleted"
	| "resolved";

/** A single sync activity event */
export interface SyncEvent {
	/** Event type */
	type: SyncEventType;
	/** Relative file path (within sync folder) */
	path: string;
	/** ISO timestamp when the event occurred */
	timestamp: string;
	/** Sync cycle ID — events with the same cycleId are grouped together */
	cycleId: string;
}

/** Maximum number of events to persist */
export const MAX_EVENTS = 100;

/** Icon mapping for each event type */
export const EVENT_ICONS: Record<SyncEventType, string> = {
	pulled: "\u2193",   // ↓
	pushed: "\u2191",   // ↑
	conflict: "\u26A0", // ⚠
	merged: "\uD83D\uDD00",  // 🔀
	deleted: "\uD83D\uDDD1",  // 🗑
	resolved: "\u2713", // ✓
};

/** Human-readable labels for each event type */
export const EVENT_LABELS: Record<SyncEventType, string> = {
	pulled: "Pulled",
	pushed: "Pushed",
	conflict: "Conflict",
	merged: "Merged",
	deleted: "Deleted",
	resolved: "Resolved",
};

/**
 * Generate a unique cycle ID for grouping events from a single sync run.
 */
export function generateCycleId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * Trim events to the maximum allowed count, keeping the newest.
 */
export function trimEvents(events: SyncEvent[]): SyncEvent[] {
	if (events.length <= MAX_EVENTS) return events;
	return events.slice(events.length - MAX_EVENTS);
}

/**
 * Format a relative time string from a timestamp.
 */
export function formatRelativeTime(timestamp: string): string {
	const now = Date.now();
	const then = new Date(timestamp).getTime();
	const diffMs = now - then;

	if (diffMs < 0) return "Just now";

	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return "Just now";

	const minutes = Math.floor(seconds / 60);
	if (minutes === 1) return "1 min ago";
	if (minutes < 60) return `${minutes} min ago`;

	const hours = Math.floor(minutes / 60);
	if (hours === 1) return "1 hour ago";
	if (hours < 24) return `${hours} hours ago`;

	const days = Math.floor(hours / 24);
	if (days === 1) return "1 day ago";
	if (days < 30) return `${days} days ago`;

	// Fall back to a short date
	const d = new Date(timestamp);
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}
