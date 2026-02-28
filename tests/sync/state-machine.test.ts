/**
 * State machine tests: every combination of remote/local state
 * and changed/unchanged for the sync decision matrix.
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
import type { SyncStateMap, LocalChange } from "../../src/sync";

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

describe("pull scenarios", () => {
	it("pulls new remote file when no local version exists", async () => {
		mockApi.addFile("inbox.md", "remote content");

		const { result, fileStates } = await performSync(
			app,
			settings,
			null,
			{},
			[]
		);

		expect(result.created).toBe(1);
		expect(vault.getContent(`${syncFolder}/inbox.md`)).toBe(
			"remote content"
		);
		expect(fileStates["inbox.md"].status).toBe("synced");
		expect(fileStates["inbox.md"].remoteHash).toBeDefined();
	});

	it("pulls updated remote file when local is unchanged", async () => {
		const oldHash = await sha256("old content");
		vault.addFile(`${syncFolder}/inbox.md`, "old content");
		mockApi.addFile("inbox.md", "new remote content", new Date().toISOString(), "new-hash");

		const fileStates: SyncStateMap = {
			"inbox.md": {
				remoteSyncedAt: new Date(Date.now() - 60000).toISOString(),
				localModifiedAt: Date.now(),
				status: "synced",
				remoteHash: oldHash,
				localHash: oldHash,
			},
		};

		const { result, fileStates: newStates } = await performSync(
			app,
			settings,
			new Date(Date.now() - 60000).toISOString(),
			fileStates,
			[]
		);

		expect(result.updated).toBe(1);
		expect(vault.getContent(`${syncFolder}/inbox.md`)).toBe(
			"new remote content"
		);
		expect(newStates["inbox.md"].status).toBe("synced");
		expect(newStates["inbox.md"].remoteHash).toBe("new-hash");
	});
});

describe("push scenarios", () => {
	it("pushes local file when remote is unchanged", async () => {
		const hash = await sha256("original");
		vault.addFile(`${syncFolder}/notes.md`, "edited locally");
		mockApi.addFile("notes.md", "original", new Date().toISOString(), hash);

		const fileStates: SyncStateMap = {
			"notes.md": {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced",
				remoteHash: hash,
				localHash: hash,
			},
		};

		const changes: LocalChange[] = [
			{ type: "modify", path: `${syncFolder}/notes.md` },
		];

		const { result, fileStates: newStates } = await performSync(
			app,
			settings,
			new Date().toISOString(),
			fileStates,
			changes
		);

		expect(result.pushed).toBe(1);
		expect(mockApi.files.get("notes.md")?.content).toBe("edited locally");
		expect(newStates["notes.md"].status).toBe("synced");
	});

	it("pushes new local file that does not exist on server", async () => {
		vault.addFile(`${syncFolder}/new-note.md`, "brand new");

		const changes: LocalChange[] = [
			{ type: "create", path: `${syncFolder}/new-note.md` },
		];

		const { result, fileStates } = await performSync(
			app,
			settings,
			null,
			{},
			changes
		);

		expect(result.pushed).toBe(1);
		expect(mockApi.files.get("new-note.md")?.content).toBe("brand new");
		expect(fileStates["new-note.md"].status).toBe("synced");
		expect(fileStates["new-note.md"].localHash).toBeDefined();
	});
});

describe("conflict scenarios", () => {
	it("detects conflict when both sides changed with different content", async () => {
		const origHash = await sha256("original");
		vault.addFile(`${syncFolder}/shared.md`, "local edit");
		mockApi.addFile("shared.md", "remote edit", new Date().toISOString(), "remote-new-hash");

		const fileStates: SyncStateMap = {
			"shared.md": {
				remoteSyncedAt: new Date(Date.now() - 60000).toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced",
				remoteHash: origHash,
				localHash: origHash,
			},
		};

		const changes: LocalChange[] = [
			{ type: "modify", path: `${syncFolder}/shared.md` },
		];

		const { result, fileStates: newStates } = await performSync(
			app,
			settings,
			new Date(Date.now() - 60000).toISOString(),
			fileStates,
			changes
		);

		expect(result.conflicts).toBe(1);
		expect(newStates["shared.md"].status).toBe("conflicted");
		expect(vault.hasFile(`${syncFolder}/shared.conflict.md`)).toBe(true);
		expect(vault.getContent(`${syncFolder}/shared.conflict.md`)).toBe(
			"remote edit"
		);
	});

	it("skips when both sides changed to identical content (hash match)", async () => {
		const origHash = await sha256("original");
		const newHash = await sha256("same edit");
		vault.addFile(`${syncFolder}/shared.md`, "same edit");
		mockApi.addFile("shared.md", "same edit", new Date().toISOString(), newHash);

		const fileStates: SyncStateMap = {
			"shared.md": {
				remoteSyncedAt: new Date(Date.now() - 60000).toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced",
				remoteHash: origHash,
				localHash: origHash,
			},
		};

		const changes: LocalChange[] = [
			{ type: "modify", path: `${syncFolder}/shared.md` },
		];

		const { result, fileStates: newStates } = await performSync(
			app,
			settings,
			new Date(Date.now() - 60000).toISOString(),
			fileStates,
			changes
		);

		expect(result.conflicts).toBe(0);
		expect(newStates["shared.md"].status).toBe("synced");
		expect(vault.hasFile(`${syncFolder}/shared.conflict.md`)).toBe(false);
	});
});

describe("delete scenarios", () => {
	it("deletes remote file when locally deleted and remote unchanged", async () => {
		const hash = await sha256("to delete");
		mockApi.addFile("gone.md", "to delete", new Date().toISOString(), hash);

		const fileStates: SyncStateMap = {
			"gone.md": {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now(),
				status: "synced",
				remoteHash: hash,
				localHash: hash,
			},
		};

		const changes: LocalChange[] = [
			{ type: "delete", path: `${syncFolder}/gone.md` },
		];

		const { result } = await performSync(
			app,
			settings,
			new Date().toISOString(),
			fileStates,
			changes
		);

		expect(result.deleted).toBe(1);
		expect(mockApi.files.has("gone.md")).toBe(false);
	});

	it("re-pulls when locally deleted but remote changed", async () => {
		const oldHash = await sha256("original");
		mockApi.addFile("important.md", "updated remotely", new Date().toISOString(), "new-hash");

		const fileStates: SyncStateMap = {
			"important.md": {
				remoteSyncedAt: new Date(Date.now() - 60000).toISOString(),
				localModifiedAt: Date.now(),
				status: "synced",
				remoteHash: oldHash,
				localHash: oldHash,
			},
		};

		const changes: LocalChange[] = [
			{ type: "delete", path: `${syncFolder}/important.md` },
		];

		const { result } = await performSync(
			app,
			settings,
			new Date(Date.now() - 60000).toISOString(),
			fileStates,
			changes
		);

		expect(result.conflicts).toBe(1);
		expect(vault.hasFile(`${syncFolder}/important.md`)).toBe(true);
	});

	it("deletes local file when remote deleted and local unchanged", async () => {
		vault.addFile(`${syncFolder}/removed.md`, "old content");

		const fileStates: SyncStateMap = {
			"removed.md": {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now(),
				status: "synced",
			},
		};

		const { result } = await performSync(
			app,
			settings,
			new Date().toISOString(),
			fileStates,
			[]
		);

		expect(result.deleted).toBe(1);
	});

	it("conflicts when remote deleted but local modified", async () => {
		vault.addFile(`${syncFolder}/edited.md`, "local changes");

		const fileStates: SyncStateMap = {
			"edited.md": {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced",
			},
		};

		const changes: LocalChange[] = [
			{ type: "modify", path: `${syncFolder}/edited.md` },
		];

		const { result, fileStates: newStates } = await performSync(
			app,
			settings,
			new Date().toISOString(),
			fileStates,
			changes
		);

		expect(result.conflicts).toBe(1);
		expect(newStates["edited.md"].status).toBe("conflicted");
	});
});

describe("no-op scenarios", () => {
	it("skips when neither side changed", async () => {
		const hash = await sha256("stable content");
		vault.addFile(`${syncFolder}/stable.md`, "stable content");
		mockApi.addFile("stable.md", "stable content", new Date().toISOString(), hash);

		const fileStates: SyncStateMap = {
			"stable.md": {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now(),
				status: "synced",
				remoteHash: hash,
				localHash: hash,
			},
		};

		const { result } = await performSync(
			app,
			settings,
			new Date().toISOString(),
			fileStates,
			[]
		);

		expect(result.created).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.pushed).toBe(0);
		expect(result.conflicts).toBe(0);
		expect(result.deleted).toBe(0);
		expect(mockApi.readFileCalls).toBe(0);
	});

	it("handles empty vault on both sides", async () => {
		const { result } = await performSync(
			app,
			settings,
			null,
			{},
			[]
		);

		expect(result.created).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.pushed).toBe(0);
		expect(result.deleted).toBe(0);
		expect(result.conflicts).toBe(0);
	});
});

describe("hash backfill", () => {
	it("backfills hashes on existing state without hashes", async () => {
		const content = "existing content";
		const hash = await sha256(content);
		vault.addFile(`${syncFolder}/old.md`, content);
		mockApi.addFile("old.md", content, new Date().toISOString(), hash);

		const fileStates: SyncStateMap = {
			"old.md": {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now(),
				status: "synced",
			},
		};

		const { fileStates: newStates } = await performSync(
			app,
			settings,
			new Date().toISOString(),
			fileStates,
			[]
		);

		expect(newStates["old.md"].remoteHash).toBeDefined();
		expect(newStates["old.md"].localHash).toBeDefined();
	});
});
