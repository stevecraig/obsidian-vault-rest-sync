/**
 * Mock Obsidian module for tests.
 * Provides minimal stubs of the Obsidian API surface used by sync.ts.
 */

export class TFile {
	path: string;
	name: string;
	basename: string;
	extension: string;
	stat: { mtime: number; ctime: number; size: number };
	vault: any;
	parent: any;

	constructor(path: string, mtime?: number, ctime?: number) {
		this.path = path;
		this.name = path.split("/").pop() ?? path;
		this.basename = this.name.replace(/\.[^.]+$/, "");
		this.extension = path.split(".").pop() ?? "";
		const now = Date.now();
		this.stat = { mtime: mtime ?? now, ctime: ctime ?? now, size: 0 };
		this.vault = {};
		this.parent = null;
	}
}

export class TFolder {
	path: string;
	name: string;
	children: any[];
	vault: any;
	parent: any;

	constructor(path: string) {
		this.path = path;
		this.name = path.split("/").pop() ?? path;
		this.children = [];
		this.vault = {};
		this.parent = null;
	}

	isRoot(): boolean {
		return false;
	}
}

export type TAbstractFile = TFile | TFolder;

export class Notice {
	constructor(_message: string, _timeout?: number) {}
}

export class Plugin {
	app: any;
	manifest: any;
	addSettingTab(_tab: any): void {}
	addCommand(_command: any): any {}
	addStatusBarItem(): any { return { setText: () => {} }; }
	registerEvent(_event: any): void {}
	registerInterval(_interval: number): number { return 0; }
	loadData(): Promise<any> { return Promise.resolve(null); }
	saveData(_data: any): Promise<void> { return Promise.resolve(); }
}

export function normalizePath(path: string): string {
	// Simple normalization: remove trailing slash, collapse double slashes
	return path.replace(/\/+/g, "/").replace(/\/$/, "");
}

export function requestUrl(_options: any): Promise<any> {
	return Promise.resolve({ status: 200, json: {} });
}
