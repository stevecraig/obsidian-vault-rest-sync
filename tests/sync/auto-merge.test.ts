/**
 * Auto-merge integration tests: verify that the sync engine
 * uses 3-way merge when ancestor content is available and
 * falls back to conflict flow when not.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	createMockApp,
	mockApi,
	createApiMock,
	defaultSettings,
	sha256,
	MockVaultHelper,
} from "./mocks";
import type { App } from "obsidian";
import type { SyncStateMap } from "../../src/sync";

vi.mock("../../src/api", () => createApiMock());

import { performSync } from "../../src/sync";

let app: App;
let vault: MockVaultHelper;

const settings = defaultSettings();
const syncFolder = settings.syncFolder;

beforeEach(() => {
	const mock = createMockApp();
	app = mock.app;
	vault = mock.vault;
	mockApi.reset();
});

describe("3-way auto-merge", () => {
	it("auto-merges when changes are in non-overlapping regions", async () => {
		const ancestor = "line 1\nline 2\nline 3\nline 4\nline 5";
		const ancestorHash = await sha256(ancestor);
		const localContent = "LOCAL 1\nline 2\nline 3\nline 4\nline 5";
		const localHash = await sha256(localContent);
		const remoteContent = "line 1\nline 2\nline 3\nline 4\nREMOTE 5";

		vault.addFile(`${syncFolder}/doc.md`, localContent);
		mockApi.addFile("doc.md", remoteContent, new Date().toISOString(), "remote-new-hash");

		const fileStates: SyncStateMap = {
			"doc.md": {
				remoteSyncedAt: new Date(Date.now() - 60000).toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced",
				remoteHash: ancestorHash,
				localHash: ancestorHash,
				ancestorContent: ancestor,
			},
		};

		const changes = [
			{ type: "modify" as const, path: `${syncFolder}/doc.md` },
		];

		const { result, fileStates: newStates } = await performSync(
			app,
			settings,
			new Date(Date.now() - 60000).toISOString(),
			fileStates,
			changes
		);

		expect(result.autoMerged).toBe(1);
		expect(result.conflicts).toBe(0);
		expect(newStates["doc.md"].status).toBe("synced");

		// Verify merged content was written locally
		const mergedContent = vault.getContent(`${syncFolder}/doc.md`);
		expect(mergedContent).toContain("LOCAL 1");
		expect(mergedContent).toContain("REMOTE 5");

		// Verify merged content was pushed to remote
		const remoteFile = mockApi.files.get("doc.md");
		expect(remoteFile?.content).toContain("LOCAL 1");
		expect(remoteFile?.content).toContain("REMOTE 5");
	});

	it("falls back to conflict when changes overlap", async () => {
		const ancestor = "line 1\nline 2\nline 3";
		const ancestorHash = await sha256(ancestor);
		const localContent = "line 1\nLOCAL EDIT\nline 3";
		const remoteContent = "line 1\nREMOTE EDIT\nline 3";

		vault.addFile(`${syncFolder}/doc.md`, localContent);
		mockApi.addFile("doc.md", remoteContent, new Date().toISOString(), "remote-new-hash");

		const fileStates: SyncStateMap = {
			"doc.md": {
				remoteSyncedAt: new Date(Date.now() - 60000).toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced",
				remoteHash: ancestorHash,
				localHash: ancestorHash,
				ancestorContent: ancestor,
			},
		};

		const changes = [
			{ type: "modify" as const, path: `${syncFolder}/doc.md` },
		];

		const { result, fileStates: newStates } = await performSync(
			app,
			settings,
			new Date(Date.now() - 60000).toISOString(),
			fileStates,
			changes
		);

		expect(result.autoMerged).toBe(0);
		expect(result.conflicts).toBe(1);
		expect(newStates["doc.md"].status).toBe("conflicted");
	});

	it("falls back to conflict when ancestor content is missing", async () => {
		const ancestorHash = await sha256("original");
		const localContent = "local version";
		const remoteContent = "remote version";

		vault.addFile(`${syncFolder}/doc.md`, localContent);
		mockApi.addFile("doc.md", remoteContent, new Date().toISOString(), "remote-new-hash");

		const fileStates: SyncStateMap = {
			"doc.md": {
				remoteSyncedAt: new Date(Date.now() - 60000).toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced",
				remoteHash: ancestorHash,
				localHash: ancestorHash,
				// No ancestorContent
			},
		};

		const changes = [
			{ type: "modify" as const, path: `${syncFolder}/doc.md` },
		];

		const { result, fileStates: newStates } = await performSync(
			app,
			settings,
			new Date(Date.now() - 60000).toISOString(),
			fileStates,
			changes
		);

		expect(result.autoMerged).toBe(0);
		expect(result.conflicts).toBe(1);
		expect(newStates["doc.md"].status).toBe("conflicted");
	});

	it("falls back to conflict when ancestor is empty string", async () => {
		const ancestorHash = await sha256("original");
		const localContent = "local version";
		const remoteContent = "remote version";

		vault.addFile(`${syncFolder}/doc.md`, localContent);
		mockApi.addFile("doc.md", remoteContent, new Date().toISOString(), "remote-new-hash");

		const fileStates: SyncStateMap = {
			"doc.md": {
				remoteSyncedAt: new Date(Date.now() - 60000).toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced",
				remoteHash: ancestorHash,
				localHash: ancestorHash,
				ancestorContent: "", // empty ancestor
			},
		};

		const changes = [
			{ type: "modify" as const, path: `${syncFolder}/doc.md` },
		];

		const { result, fileStates: newStates } = await performSync(
			app,
			settings,
			new Date(Date.now() - 60000).toISOString(),
			fileStates,
			changes
		);

		expect(result.autoMerged).toBe(0);
		expect(result.conflicts).toBe(1);
		expect(newStates["doc.md"].status).toBe("conflicted");
	});

	it("falls back to conflict for binary-looking content (no newlines)", async () => {
		const ancestor = "a".repeat(300);
		const ancestorHash = await sha256(ancestor);
		// Long content with no newlines = binary-looking
		const localContent = "b".repeat(300);
		const remoteContent = "c".repeat(300);

		vault.addFile(`${syncFolder}/doc.md`, localContent);
		mockApi.addFile("doc.md", remoteContent, new Date().toISOString(), "remote-new-hash");

		const fileStates: SyncStateMap = {
			"doc.md": {
				remoteSyncedAt: new Date(Date.now() - 60000).toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced",
				remoteHash: ancestorHash,
				localHash: ancestorHash,
				ancestorContent: ancestor,
			},
		};

		const changes = [
			{ type: "modify" as const, path: `${syncFolder}/doc.md` },
		];

		const { result, fileStates: newStates } = await performSync(
			app,
			settings,
			new Date(Date.now() - 60000).toISOString(),
			fileStates,
			changes
		);

		expect(result.autoMerged).toBe(0);
		expect(result.conflicts).toBe(1);
		expect(newStates["doc.md"].status).toBe("conflicted");
	});

	it("updates ancestor content after successful auto-merge", async () => {
		const ancestor = "line 1\nline 2\nline 3\nline 4\nline 5";
		const ancestorHash = await sha256(ancestor);
		const localContent = "LOCAL 1\nline 2\nline 3\nline 4\nline 5";
		const remoteContent = "line 1\nline 2\nline 3\nline 4\nREMOTE 5";

		vault.addFile(`${syncFolder}/doc.md`, localContent);
		mockApi.addFile("doc.md", remoteContent, new Date().toISOString(), "remote-new-hash");

		const fileStates: SyncStateMap = {
			"doc.md": {
				remoteSyncedAt: new Date(Date.now() - 60000).toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced",
				remoteHash: ancestorHash,
				localHash: ancestorHash,
				ancestorContent: ancestor,
			},
		};

		const changes = [
			{ type: "modify" as const, path: `${syncFolder}/doc.md` },
		];

		const { fileStates: newStates } = await performSync(
			app,
			settings,
			new Date(Date.now() - 60000).toISOString(),
			fileStates,
			changes
		);

		// After merge, ancestor should be updated to the merged result
		expect(newStates["doc.md"].ancestorContent).toBeDefined();
		expect(newStates["doc.md"].ancestorContent).toContain("LOCAL 1");
		expect(newStates["doc.md"].ancestorContent).toContain("REMOTE 5");
	});
});
