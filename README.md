# Remote Vault Sync

An Obsidian plugin that syncs files from a remote REST API into your vault. Files are pulled automatically on a configurable interval and kept read-only — local changes to synced files will be overwritten on the next sync.

## Features

- Pull files from any REST API that implements the expected contract
- Automatic sync on a configurable interval (default: 15 minutes)
- Manual sync via command palette ("Remote Vault Sync: Sync now")
- Synced files are placed in a dedicated folder (default: `Remote Vault`)
- Files removed from the server are automatically deleted locally
- Read-only banner added to synced files as a visual reminder
- Works on desktop and mobile

## Installation

### Via BRAT (recommended)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Open BRAT settings and click "Add Beta Plugin"
3. Enter the repository URL: `https://github.com/stevecraig/obsidian-vault-rest-sync`
4. Enable the plugin in Settings > Community Plugins

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/stevecraig/obsidian-vault-rest-sync/releases)
2. Create a folder `remote-vault-sync` inside your vault's `.obsidian/plugins/` directory
3. Place `main.js` and `manifest.json` in that folder
4. Enable the plugin in Settings > Community Plugins

## Configuration

Open Settings > Remote Vault Sync to configure:

| Setting | Description | Default |
|---------|-------------|---------|
| **API URL** | Base URL of the REST file API | *(none — required)* |
| **API Token** | Bearer token for authentication | *(none — required)* |
| **Sync folder** | Local vault folder for synced files | `Remote Vault` |
| **Sync interval** | Minutes between automatic syncs | `15` |

## REST API Contract

This plugin works with any server that implements the following two endpoints. Authentication is via a `Bearer` token in the `Authorization` header.

### List files

```
GET <base-url>
GET <base-url>?since=<ISO-8601-timestamp>
```

**Response:** JSON array of file entries.

```json
[
  {
    "path": "notes/example.md",
    "createdAt": "2024-01-15T10:30:00Z",
    "updatedAt": "2024-06-20T14:00:00Z",
    "size": 1234
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | Relative file path (forward slashes, no leading slash) |
| `createdAt` | string | ISO 8601 creation timestamp |
| `updatedAt` | string | ISO 8601 last-modified timestamp |
| `size` | number | File size in bytes |

The optional `since` query parameter filters to files updated after the given timestamp.

### Read file

```
GET <base-url>/<path>
```

**Response:** JSON object with the file content.

```json
{
  "content": "# Example\n\nFile content here...",
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-06-20T14:00:00Z",
  "size": 1234
}
```

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | Full file content as a string |
| `createdAt` | string | ISO 8601 creation timestamp |
| `updatedAt` | string | ISO 8601 last-modified timestamp |
| `size` | number | File size in bytes |

### Authentication

All requests include an `Authorization: Bearer <token>` header. The server should return:

- `401` for invalid or missing tokens
- `403` for valid tokens with insufficient permissions
- `404` for files that don't exist

## How sync works

1. The plugin fetches the full file list from the API
2. Remote files are compared against local files by path and `updatedAt` timestamp
3. New files are created in the sync folder; changed files are updated
4. Files that exist locally but are absent from the server are deleted
5. A read-only warning banner is prepended to each synced file
6. Empty folders left behind after deletions are cleaned up

## License

MIT
