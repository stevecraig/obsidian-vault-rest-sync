/**
 * Fetch-based SSE client for real-time change notifications.
 *
 * Uses raw fetch + ReadableStream to parse Server-Sent Events,
 * since the browser EventSource API does not support custom headers
 * (needed for Authorization: Bearer).
 *
 * Reconnects automatically with exponential backoff, passing
 * Last-Event-ID to replay missed events.
 *
 * Supports adaptive idle disconnect: the client can be paused after
 * a configurable period of no incoming events or no user activity,
 * and resumed instantly on demand.
 */

export interface SSEFileEvent {
	type: string;
	path: string;
	hash?: string;
	updatedAt?: string;
}

export interface SSEClientOptions {
	/** Full URL to the SSE events endpoint */
	url: string;
	/** Bearer token for Authorization header */
	token: string;
	/** Called when a file_changed event arrives */
	onFileChanged: (event: SSEFileEvent) => void;
	/** Called when a file_deleted event arrives */
	onFileDeleted: (event: SSEFileEvent) => void;
	/** Called when the connection opens successfully */
	onConnected?: () => void;
	/** Called when the connection is lost (before reconnect) */
	onDisconnected?: () => void;
	/** Called on non-recoverable error */
	onError?: (error: Error) => void;
	/** Maximum reconnect delay in ms (default: 30000) */
	reconnectMaxMs?: number;
	/** Minutes of no SSE events before idle disconnect (0 = disabled) */
	eventIdleMinutes?: number;
	/** Minutes of no user activity before idle disconnect (0 = disabled) */
	userIdleMinutes?: number;
	/** Called when the connection is paused due to idle timeout */
	onIdlePause?: (reason: "event-idle" | "user-idle") => void;
}

export class SSEClient {
	private url: string;
	private token: string;
	private onFileChanged: (event: SSEFileEvent) => void;
	private onFileDeleted: (event: SSEFileEvent) => void;
	private onConnected?: () => void;
	private onDisconnected?: () => void;
	private onError?: (error: Error) => void;
	private onIdlePause?: (reason: "event-idle" | "user-idle") => void;

	private reconnectMaxMs: number;
	private eventIdleMs: number;
	private userIdleMs: number;
	private lastEventId: string | null = null;
	private abortController: AbortController | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	private stopped = false;
	private _connected = false;

	/** Whether the client is in idle-paused state (stopped but resumable) */
	private _idlePaused = false;

	/** Timer that fires when no SSE events arrive for eventIdleMs */
	private eventIdleTimer: ReturnType<typeof setTimeout> | null = null;
	/** Timer that fires when no user activity for userIdleMs */
	private userIdleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: SSEClientOptions) {
		this.url = options.url;
		this.token = options.token;
		this.onFileChanged = options.onFileChanged;
		this.onFileDeleted = options.onFileDeleted;
		this.onConnected = options.onConnected;
		this.onDisconnected = options.onDisconnected;
		this.onError = options.onError;
		this.onIdlePause = options.onIdlePause;
		this.reconnectMaxMs = options.reconnectMaxMs ?? 30000;
		this.eventIdleMs = (options.eventIdleMinutes ?? 0) * 60 * 1000;
		this.userIdleMs = (options.userIdleMinutes ?? 0) * 60 * 1000;
	}

	/** Whether the SSE connection is currently active */
	get connected(): boolean {
		return this._connected;
	}

	/** Whether the client is paused due to idle timeout */
	get idlePaused(): boolean {
		return this._idlePaused;
	}

	/** Start the SSE connection */
	start(): void {
		this.stopped = false;
		this._idlePaused = false;
		this.connect();
		this.resetUserIdleTimer();
	}

	/** Stop the SSE connection and cancel any pending reconnect */
	stop(): void {
		this.stopped = true;
		this._connected = false;
		this._idlePaused = false;
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.clearIdleTimers();
	}

	/** Reconnect with new URL/token (e.g. after settings change) */
	reconnectWith(url: string, token: string): void {
		this.stop();
		this.url = url;
		this.token = token;
		this.lastEventId = null;
		this.reconnectAttempt = 0;
		this.start();
	}

	/**
	 * Signal user activity. Resets the user idle timer and
	 * resumes the connection if it was idle-paused.
	 */
	notifyUserActivity(): void {
		this.resetUserIdleTimer();

		if (this._idlePaused) {
			this.resume();
		}
	}

	/**
	 * Resume from idle-paused state. Reconnects immediately
	 * without backoff.
	 */
	private resume(): void {
		if (!this._idlePaused) return;
		this._idlePaused = false;
		this.stopped = false;
		this.reconnectAttempt = 0;
		this.connect();
	}

	/**
	 * Pause the connection due to idle timeout. Disconnects
	 * but stays resumable (not fully stopped).
	 */
	private idlePause(reason: "event-idle" | "user-idle"): void {
		if (this.stopped || this._idlePaused) return;
		this._idlePaused = true;
		this._connected = false;

		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.clearIdleTimers();

		this.onDisconnected?.();
		this.onIdlePause?.(reason);
	}

	/** Reset the event idle timer (called on every incoming SSE event) */
	private resetEventIdleTimer(): void {
		if (this.eventIdleTimer) {
			clearTimeout(this.eventIdleTimer);
			this.eventIdleTimer = null;
		}
		if (this.eventIdleMs > 0 && this._connected) {
			this.eventIdleTimer = setTimeout(() => {
				this.eventIdleTimer = null;
				this.idlePause("event-idle");
			}, this.eventIdleMs);
		}
	}

	/** Reset the user idle timer */
	private resetUserIdleTimer(): void {
		if (this.userIdleTimer) {
			clearTimeout(this.userIdleTimer);
			this.userIdleTimer = null;
		}
		if (this.userIdleMs > 0 && !this.stopped) {
			this.userIdleTimer = setTimeout(() => {
				this.userIdleTimer = null;
				this.idlePause("user-idle");
			}, this.userIdleMs);
		}
	}

	/** Clear all idle timers */
	private clearIdleTimers(): void {
		if (this.eventIdleTimer) {
			clearTimeout(this.eventIdleTimer);
			this.eventIdleTimer = null;
		}
		if (this.userIdleTimer) {
			clearTimeout(this.userIdleTimer);
			this.userIdleTimer = null;
		}
	}

	private connect(): void {
		if (this.stopped && !this._idlePaused) return;

		this.abortController = new AbortController();
		const headers: Record<string, string> = {
			"Authorization": `Bearer ${this.token}`,
			"Accept": "text/event-stream",
		};
		if (this.lastEventId) {
			headers["Last-Event-ID"] = this.lastEventId;
		}

		fetch(this.url, {
			method: "GET",
			headers,
			signal: this.abortController.signal,
		})
			.then((response) => {
				if (this.stopped) return;

				if (!response.ok) {
					throw new Error(
						`SSE connection failed: ${response.status} ${response.statusText}`
					);
				}

				if (!response.body) {
					throw new Error("SSE response has no body");
				}

				// Connection established — reset backoff
				this._connected = true;
				this.reconnectAttempt = 0;
				this.onConnected?.();

				// Start event idle timer now that we're connected
				this.resetEventIdleTimer();

				return this.readStream(response.body);
			})
			.then(() => {
				// Stream ended normally
				if (!this.stopped && !this._idlePaused) {
					this._connected = false;
					this.onDisconnected?.();
					this.scheduleReconnect();
				}
			})
			.catch((err: unknown) => {
				if (this.stopped || this._idlePaused) return;

				this._connected = false;

				// AbortError is expected when we call stop() or idlePause()
				if (err instanceof Error && err.name === "AbortError") return;

				this.onDisconnected?.();
				this.onError?.(
					err instanceof Error ? err : new Error(String(err))
				);
				this.scheduleReconnect();
			});
	}

	private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		// SSE parser state
		let eventType = "";
		let eventData = "";
		let eventId = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done || this.stopped || this._idlePaused) break;

				buffer += decoder.decode(value, { stream: true });

				// Process complete lines
				let newlineIndex: number;
				while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
					buffer = buffer.slice(newlineIndex + 1);

					if (line === "") {
						// Empty line = end of event, dispatch it
						if (eventData) {
							this.dispatchEvent(eventType, eventData, eventId);
						}
						// Reset for next event
						eventType = "";
						eventData = "";
						eventId = "";
					} else if (line.startsWith(":")) {
						// Comment line — ignore (server heartbeat)
					} else if (line.startsWith("event:")) {
						eventType = line.slice(6).trim();
					} else if (line.startsWith("data:")) {
						// Accumulate data lines (spec allows multiple data: lines)
						const payload = line.slice(5).trim();
						eventData = eventData ? eventData + "\n" + payload : payload;
					} else if (line.startsWith("id:")) {
						eventId = line.slice(3).trim();
					}
					// ignore retry: and unknown fields
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	private dispatchEvent(
		eventType: string,
		data: string,
		id: string
	): void {
		// Update cursor for reconnection
		if (id) {
			this.lastEventId = id;
		}

		// Reset event idle timer on every incoming event
		this.resetEventIdleTimer();

		// Handle reconnect event — server is about to close the connection,
		// reconnect immediately without backoff
		if (eventType === "reconnect") {
			this._connected = false;
			if (this.abortController) {
				this.abortController.abort();
				this.abortController = null;
			}
			this.reconnectAttempt = 0;
			// Don't fire onDisconnected — this is a seamless handover
			this.connect();
			return;
		}

		let parsed: SSEFileEvent;
		try {
			parsed = JSON.parse(data) as SSEFileEvent;
		} catch {
			// Malformed JSON — skip
			return;
		}

		if (!parsed.path) return;

		if (eventType === "file_deleted") {
			this.onFileDeleted(parsed);
		} else {
			// file_changed or default
			this.onFileChanged(parsed);
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped || this._idlePaused) return;

		// Exponential backoff: 1s, 2s, 4s, 8s... capped at reconnectMaxMs
		const baseDelay = 1000;
		const delay = Math.min(
			baseDelay * Math.pow(2, this.reconnectAttempt),
			this.reconnectMaxMs
		);
		// Add jitter: +/- 20%
		const jitter = delay * 0.2 * (Math.random() * 2 - 1);
		const finalDelay = Math.round(delay + jitter);

		this.reconnectAttempt++;

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, finalDelay);
	}
}
