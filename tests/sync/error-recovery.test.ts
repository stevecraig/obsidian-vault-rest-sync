/**
 * Error recovery tests: network failures, partial sync, auth errors.
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

vi.mock("../../src/api", () => createApiMock());

import { performSync } from "../../src/sync";
import * as apiModule from "../../src/api";

let app: App;
let vault: MockVaultHelper;

const settings = defaultSettings();
const syncFolder = settings.syncFolder;

beforeEach(() => {
	const mock = createMockApp();
	app = mock.app;
	vault = mock.vault;
	mockApi.reset();
	vi.restoreAllMocks();
});

describe("network failures", () => {
	it("throws when listFiles fails (caller should handle)", async () => {
		mockApi.failNextList = true;

		await expect(
			performSync(app, settings, null, {}, [])
		).rejects.toThrow("Network error: listFiles");
	});

	it("counts error when single file pull fails but continues", async () => {
		mockApi.addFile("good.md", "works fine");
		mockApi.addFile("bad.md", "will fail");

		// Override readFile to fail only for bad.md
		vi.mocked(apiModule.readFile).mockImplementation(
			async (_baseUrl: string, _token: string, path: string) => {
				if (path === "bad.md") {
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
		);

		const { result } = await performSync(app, settings, null, {}, []);

		expect(result.errors).toBe(1);
		expect(result.created).toBe(1);
		expect(vault.hasFile(`${syncFolder}/good.md`)).toBe(true);
	});

	it("counts error when push fails but continues with other files", async () => {
		vault.addFile(`${syncFolder}/a.md`, "content a");
		vault.addFile(`${syncFolder}/b.md`, "content b");

		vi.mocked(apiModule.writeFile).mockImplementation(
			async (_baseUrl: string, _token: string, path: string, content: string) => {
				if (path === "a.md") {
					throw new Error("Network error: writeFile");
				}
				const now = new Date().toISOString();
				mockApi.files.set(path, {
					content,
					createdAt: now,
					updatedAt: now,
					size: content.length,
					hash: "h",
				} as any);
			}
		);

		const changes = [
			{ type: "create" as const, path: `${syncFolder}/a.md` },
			{ type: "create" as const, path: `${syncFolder}/b.md` },
		];

		const { result } = await performSync(app, settings, null, {}, changes);

		expect(result.errors).toBe(1);
		expect(result.pushed).toBe(1);
	});
});

describe("missing configuration", () => {
	it("throws when API URL is not configured", async () => {
		const badSettings = { ...settings, apiUrl: "" };

		await expect(
			performSync(app, badSettings, null, {}, [])
		).rejects.toThrow("API URL and token must be configured");
	});

	it("throws when API token is not configured", async () => {
		const badSettings = { ...settings, apiToken: "" };

		await expect(
			performSync(app, badSettings, null, {}, [])
		).rejects.toThrow("API URL and token must be configured");
	});
});
