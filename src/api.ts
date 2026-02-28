import { requestUrl, RequestUrlResponse } from "obsidian";

export interface FileListEntry {
	path: string;
	createdAt: string;
	updatedAt: string;
	size: number;
}

export interface FileContent {
	content: string;
	createdAt: string;
	updatedAt: string;
	size: number;
}

export class ApiError extends Error {
	constructor(public status: number, message: string) {
		super(message);
		this.name = "ApiError";
	}
}

function headers(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
	};
}

function handleResponse(response: RequestUrlResponse): void {
	if (response.status === 401) {
		throw new ApiError(401, "Unauthorized — check your API token");
	}
	if (response.status === 403) {
		throw new ApiError(403, "Forbidden — insufficient permissions");
	}
	if (response.status === 404) {
		throw new ApiError(404, "Not found");
	}
	if (response.status >= 400) {
		throw new ApiError(
			response.status,
			`Request failed with status ${response.status}`
		);
	}
}

/**
 * List all files from the remote API.
 * Optionally pass `since` ISO timestamp to only get files updated after that time.
 */
export async function listFiles(
	baseUrl: string,
	token: string,
	since?: string
): Promise<FileListEntry[]> {
	let url = baseUrl.replace(/\/+$/, "");
	if (since) {
		url += `?since=${encodeURIComponent(since)}`;
	}

	const response = await requestUrl({
		url,
		method: "GET",
		headers: headers(token),
	});

	handleResponse(response);
	return response.json as FileListEntry[];
}

/**
 * Read a single file's content from the remote API.
 */
export async function readFile(
	baseUrl: string,
	token: string,
	path: string
): Promise<FileContent> {
	const url = `${baseUrl.replace(/\/+$/, "")}/${encodeURI(path)}`;

	const response = await requestUrl({
		url,
		method: "GET",
		headers: headers(token),
	});

	handleResponse(response);
	return response.json as FileContent;
}
