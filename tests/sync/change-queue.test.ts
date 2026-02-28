/**
 * Change queue processing tests: verify how local change events
 * are collapsed, filtered, and applied during sync.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	createMockApp,
	mockApi,
	createApiMock,
	defaultSettings,
	MockVaultHelper,
} from "./mocks";
import type { App } from "obsidian";
import type { LocalChange } from "../../src/sync";

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

describe("change collapsing", () => {
	it("multiple edits to same file result in single push", async () => {
		vault.addFile(`${syncFolder}/notes.md`, "final version");
		mockApi.addFile("notes.md", "original");

		const fileStates = {
			"notes.md": {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced" as const,
			},
		};

		const changes: LocalChange[] = [
			{ type: "modify", path: `${syncFolder}/notes.md` },
			{ type: "modify", path: `${syncFolder}/notes.md` },
			{ type: "modify", path: `${syncFolder}/notes.md` },
		];

		const { result } = await performSync(
			app,
			settings,
			new Date().toISOString(),
			fileStates,
			changes
		);

		expect(result.pushed).toBe(1);
		expect(mockApi.writeFileCalls).toBe(1);
	});
});

describe("rename handling", () => {
	it("rename within sync folder deletes old path and pushes new", async () => {
		vault.addFile(`${syncFolder}/new-name.md`, "renamed content");
		mockApi.addFile("old-name.md", "renamed content");

		const fileStates = {
			"old-name.md": {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now(),
				status: "synced" as const,
			},
		};

		const changes: LocalChange[] = [
			{
				type: "rename",
				path: `${syncFolder}/new-name.md`,
				oldPath: `${syncFolder}/old-name.md`,
			},
		];

		const { result } = await performSync(
			app,
			settings,
			new Date().toISOString(),
			fileStates,
			changes
		);

		expect(mockApi.files.has("old-name.md")).toBe(false);
		expect(result.pushed).toBe(1);
		expect(mockApi.files.has("new-name.md")).toBe(true);
	});
});

describe("filtering", () => {
	it("ignores conflict files in change queue", async () => {
		vault.addFile(`${syncFolder}/test.conflict.md`, "conflict content");

		const changes: LocalChange[] = [
			{ type: "create", path: `${syncFolder}/test.conflict.md` },
		];

		const { result } = await performSync(
			app,
			settings,
			null,
			{},
			changes
		);

		expect(result.pushed).toBe(0);
		expect(mockApi.files.has("test.conflict.md")).toBe(false);
	});

	it("ignores changes outside sync folder", async () => {
		vault.addFile("Other Folder/notes.md", "outside sync");

		const changes: LocalChange[] = [
			{ type: "create", path: "Other Folder/notes.md" },
		];

		const { result } = await performSync(
			app,
			settings,
			null,
			{},
			changes
		);

		expect(result.pushed).toBe(0);
	});
});

describe("delete then create", () => {
	it("delete followed by create of same path treats as modify", async () => {
		vault.addFile(`${syncFolder}/revived.md`, "recreated");
		mockApi.addFile("revived.md", "original");

		const fileStates = {
			"revived.md": {
				remoteSyncedAt: new Date().toISOString(),
				localModifiedAt: Date.now() - 60000,
				status: "synced" as const,
			},
		};

		const changes: LocalChange[] = [
			{ type: "delete", path: `${syncFolder}/revived.md` },
			{ type: "create", path: `${syncFolder}/revived.md` },
		];

		const { result } = await performSync(
			app,
			settings,
			new Date().toISOString(),
			fileStates,
			changes
		);

		expect(result.pushed).toBe(1);
		expect(mockApi.files.get("revived.md")?.content).toBe("recreated");
	});
});
