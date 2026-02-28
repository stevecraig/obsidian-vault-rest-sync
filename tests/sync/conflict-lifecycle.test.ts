/**
 * Conflict lifecycle tests: creation, resolution, banner handling.
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

import {
	performSync,
	resolveConflicts,
	countConflicts,
	isConflictFile,
} from "../../src/sync";

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

describe("conflict creation", () => {
	it("creates .conflict.md with remote content and banners local file", async () => {
		const origHash = await sha256("original");
		vault.addFile(`${syncFolder}/doc.md`, "local version");
		mockApi.addFile("doc.md", "remote version", new Date().toISOString(), "new-hash");

		const fileStates: SyncStateMap = {
			"doc.md": {
				remoteSyncedAt: new Date(Date.now() - 60000).toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced",
				remoteHash: origHash,
				localHash: origHash,
			},
		};

		const changes = [
			{ type: "modify" as const, path: `${syncFolder}/doc.md` },
		];

		await performSync(app, settings, null, fileStates, changes);

		expect(vault.hasFile(`${syncFolder}/doc.conflict.md`)).toBe(true);
		expect(vault.getContent(`${syncFolder}/doc.conflict.md`)).toBe(
			"remote version"
		);

		const localContent = vault.getContent(`${syncFolder}/doc.md`);
		expect(localContent).toContain("> [!danger] CONFLICT:");
		expect(localContent).toContain("local version");
	});
});

describe("conflict resolution", () => {
	it("resolves conflict when .conflict.md is deleted", async () => {
		const banner =
			"> [!danger] CONFLICT: This file was modified both locally and on the server.\n" +
			"> A copy of the remote version has been saved as `doc.conflict.md`.\n" +
			"> Resolve the conflict manually, then delete the `.conflict.md` file.\n\n" +
			"local version";
		vault.addFile(`${syncFolder}/doc.md`, banner);

		const fileStates: SyncStateMap = {
			"doc.md": {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now(),
				status: "conflicted",
			},
		};

		const resolved = await resolveConflicts(app, syncFolder, fileStates);

		expect(resolved).toBe(1);
		expect(fileStates["doc.md"].status).toBe("synced");
		const content = vault.getContent(`${syncFolder}/doc.md`);
		expect(content).toBe("local version");
	});

	it("does not resolve if .conflict.md still exists", async () => {
		vault.addFile(`${syncFolder}/doc.md`, "local version");
		vault.addFile(`${syncFolder}/doc.conflict.md`, "remote version");

		const fileStates: SyncStateMap = {
			"doc.md": {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now(),
				status: "conflicted",
			},
		};

		const resolved = await resolveConflicts(app, syncFolder, fileStates);

		expect(resolved).toBe(0);
		expect(fileStates["doc.md"].status).toBe("conflicted");
	});
});

describe("conflict counting", () => {
	it("counts conflicted files", () => {
		const fileStates: SyncStateMap = {
			"a.md": { remoteSyncedAt: "", localModifiedAt: 0, status: "synced" },
			"b.md": {
				remoteSyncedAt: "",
				localModifiedAt: 0,
				status: "conflicted",
			},
			"c.md": {
				remoteSyncedAt: "",
				localModifiedAt: 0,
				status: "conflicted",
			},
			"d.md": { remoteSyncedAt: "", localModifiedAt: 0, status: "synced" },
		};

		expect(countConflicts(fileStates)).toBe(2);
	});
});

describe("conflict file detection", () => {
	it("identifies .conflict.md files", () => {
		expect(isConflictFile("doc.conflict.md")).toBe(true);
		expect(isConflictFile("path/to/doc.conflict.md")).toBe(true);
		expect(isConflictFile("doc.md")).toBe(false);
		expect(isConflictFile("conflict.md")).toBe(false);
	});
});
