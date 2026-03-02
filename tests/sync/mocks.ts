/**
 * Mock layer for testing the sync engine without Obsidian runtime.
 *
 * Provides:
 * - MockVault: in-memory file system implementing the Obsidian Vault API surface
 * - mockApi: shared state for the API mock (tests configure this before each test)
 * - Helper functions for constructing test fixtures
 */

import { vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import type { FileListEntry, FileContent } from "../../src/api";

// ── In-memory file store ──

interface MockFileData {
	content: string;
	mtime: number;
	ctime: number;
}

/**
 * Helper to manipulate the mock vault directly in tests.
 */
export class MockVaultHelper {
	constructor(public files: Map<string, MockFileData>) {}

	addFile(path: string, content: string, mtime?: number): void {
		const now = mtime ?? Date.now();
		this.files.set(path, { content, mtime: now, ctime: now });
	}

	getContent(path: string): string | undefined {
		return this.files.get(path)?.content;
	}

	hasFile(path: string): boolean {
		return this.files.has(path);
	}

	allPaths(): string[] {
		return [...this.files.keys()];
	}
}

/**
 * Builds a mock Obsidian App with an in-memory vault.
 */
export function createMockApp(): {
	app: App;
	vault: MockVaultHelper;
} {
	const files = new Map<string, MockFileData>();
	const helper = new MockVaultHelper(files);

	const vault = {
		read: vi.fn(async (file: TFile): Promise<string> => {
			const data = files.get(file.path);
			if (!data) throw new Error(`File not found: ${file.path}`);
			return data.content;
		}),

		create: vi.fn(async (path: string, content: string): Promise<TFile> => {
			const now = Date.now();
			files.set(path, { content, mtime: now, ctime: now });
			return new TFile(path, now, now);
		}),

		modify: vi.fn(async (file: TFile, content: string): Promise<void> => {
			const existing = files.get(file.path);
			const now = Date.now();
			files.set(file.path, {
				content,
				mtime: now,
				ctime: existing?.ctime ?? now,
			});
		}),

		delete: vi.fn(async (file: TAbstractFile): Promise<void> => {
			files.delete(file.path);
		}),

		createFolder: vi.fn(async (_path: string): Promise<void> => {}),

		getAbstractFileByPath: vi.fn(
			(path: string): TAbstractFile | null => {
				if (files.has(path)) {
					const data = files.get(path)!;
					return new TFile(path, data.mtime, data.ctime);
				}
				// Check if any files exist under this path (folder)
				const prefix = path + "/";
				const childPaths: string[] = [];
				for (const key of files.keys()) {
					if (key.startsWith(prefix)) {
						childPaths.push(key);
					}
				}
				if (childPaths.length > 0) {
					return buildFolderTree(path, childPaths, files);
				}
				return null;
			}
		),
	};

	const app = { vault } as unknown as App;
	return { app, vault: helper };
}

// ── Folder tree builder ──

/**
 * Build a TFolder with children populated from the file map.
 * Recursively creates sub-folders as needed.
 */
function buildFolderTree(
	folderPath: string,
	childPaths: string[],
	files: Map<string, MockFileData>
): TFolder {
	const folder = new TFolder(folderPath);
	const prefix = folderPath + "/";
	const directChildren = new Map<string, string[]>();

	for (const fullPath of childPaths) {
		const relative = fullPath.slice(prefix.length);
		const slashIdx = relative.indexOf("/");

		if (slashIdx === -1) {
			// Direct child file
			const data = files.get(fullPath)!;
			const file = new TFile(fullPath, data.mtime, data.ctime);
			(file as any).parent = folder;
			folder.children.push(file as any);
		} else {
			// Nested — group by immediate subfolder
			const subFolderName = relative.slice(0, slashIdx);
			const subFolderPath = prefix + subFolderName;
			if (!directChildren.has(subFolderPath)) {
				directChildren.set(subFolderPath, []);
			}
			directChildren.get(subFolderPath)!.push(fullPath);
		}
	}

	// Recursively build sub-folders
	for (const [subPath, subChildPaths] of directChildren) {
		const subFolder = buildFolderTree(subPath, subChildPaths, files);
		(subFolder as any).parent = folder;
		folder.children.push(subFolder as any);
	}

	return folder;
}

// ── Shared API mock state ──

interface MockRemoteFile {
	content: string;
	createdAt: string;
	updatedAt: string;
	size: number;
	hash: string;
}

/** Shared mock API state — configure in beforeEach, consumed by the vi.mock factory. */
export const mockApi = {
	files: new Map<string, MockRemoteFile>(),
	failNextList: false,
	failNextRead: false,
	failNextWrite: false,
	listFilesCalls: 0,
	readFileCalls: 0,
	writeFileCalls: 0,
	deleteFileCalls: 0,

	reset(): void {
		this.files.clear();
		this.failNextList = false;
		this.failNextRead = false;
		this.failNextWrite = false;
		this.listFilesCalls = 0;
		this.readFileCalls = 0;
		this.writeFileCalls = 0;
		this.deleteFileCalls = 0;
	},

	addFile(
		path: string,
		content: string,
		updatedAt?: string,
		hash?: string
	): void {
		const now = updatedAt ?? new Date().toISOString();
		this.files.set(path, {
			content,
			createdAt: now,
			updatedAt: now,
			size: content.length,
			hash: hash ?? "hash-" + path,
		});
	},

	updateFile(path: string, content: string, hash?: string): void {
		const existing = this.files.get(path);
		if (!existing) throw new Error(`Remote file not found: ${path}`);
		existing.content = content;
		existing.updatedAt = new Date().toISOString();
		existing.size = content.length;
		existing.hash = hash ?? "hash-" + path + "-updated";
	},
};

// ── API mock factory (used by vi.mock) ──

export function createApiMock() {
	return {
		ApiError: class ApiError extends Error {
			status: number;
			constructor(status: number, message: string) {
				super(message);
				this.name = "ApiError";
				this.status = status;
			}
		},

		listFiles: vi.fn(async (): Promise<FileListEntry[]> => {
			mockApi.listFilesCalls++;
			if (mockApi.failNextList) {
				mockApi.failNextList = false;
				throw new Error("Network error: listFiles");
			}
			return [...mockApi.files.entries()].map(([path, f]) => ({
				path,
				createdAt: f.createdAt,
				updatedAt: f.updatedAt,
				size: f.size,
				hash: f.hash,
			}));
		}),

		readFile: vi.fn(
			async (
				_baseUrl: string,
				_token: string,
				path: string,
				_etag?: string
			): Promise<FileContent | null> => {
				mockApi.readFileCalls++;
				if (mockApi.failNextRead) {
					mockApi.failNextRead = false;
					throw new Error("Network error: readFile");
				}
				const f = mockApi.files.get(path);
				if (!f) throw new Error(`Not found: ${path}`);
				return {
					content: f.content,
					createdAt: f.createdAt,
					updatedAt: f.updatedAt,
					size: f.size,
					hash: f.hash,
				};
			}
		),

		writeFile: vi.fn(
			async (
				_baseUrl: string,
				_token: string,
				path: string,
				content: string
			): Promise<void> => {
				mockApi.writeFileCalls++;
				if (mockApi.failNextWrite) {
					mockApi.failNextWrite = false;
					throw new Error("Network error: writeFile");
				}
				const existing = mockApi.files.get(path);
				const now = new Date().toISOString();
				mockApi.files.set(path, {
					content,
					createdAt: existing?.createdAt ?? now,
					updatedAt: now,
					size: content.length,
					hash: "hash-" + path + "-pushed",
				});
			}
		),

		deleteFile: vi.fn(
			async (
				_baseUrl: string,
				_token: string,
				path: string
			): Promise<boolean> => {
				mockApi.deleteFileCalls++;
				const existed = mockApi.files.has(path);
				mockApi.files.delete(path);
				return existed;
			}
		),
	};
}

// ── Test settings ──

export function defaultSettings() {
	return {
		apiUrl: "https://test.example.com/api/files",
		apiToken: "test-token",
		syncFolder: "Remote Vault",
		syncIntervalMinutes: 5,
		allowEdits: true,
		allowDeletes: true,
	};
}

// ── SHA-256 helper (same as sync.ts, for test assertions) ──

export async function sha256(content: string): Promise<string> {
	const data = new TextEncoder().encode(content);
	const buf = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
