# Dropbox API

Base URL: `https://api.dropboxapi.com/2`

Cloud file storage API. Browse, upload, download, search, and share files. **All API calls use POST** (even reads), which is unique to Dropbox. File content operations (upload/download) use a separate domain: `https://content.dropboxapi.com/2`.

## Endpoints

### Get Current Account
`POST /users/get_current_account`

Returns the authenticated user's account info. No request body needed.

**Response:**
```json
{
  "account_id": "dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc",
  "name": {
    "given_name": "John",
    "surname": "Doe",
    "familiar_name": "John",
    "display_name": "John Doe"
  },
  "email": "john@example.com",
  "email_verified": true,
  "country": "FR",
  "locale": "en"
}
```

### List Folder
`POST /files/list_folder`

Lists contents of a folder. Requires `files.metadata.read` scope.

**Request body (JSON):**
```json
{
  "path": "/Documents",
  "recursive": false,
  "include_deleted": false,
  "limit": 100
}
```

Use `""` (empty string) for the root folder.

**Response:**
```json
{
  "entries": [
    {
      ".tag": "folder",
      "name": "Projects",
      "path_lower": "/documents/projects",
      "path_display": "/Documents/Projects",
      "id": "id:a4ayc_80_OEAAAAAAAAAXw"
    },
    {
      ".tag": "file",
      "name": "report.pdf",
      "path_lower": "/documents/report.pdf",
      "path_display": "/Documents/report.pdf",
      "id": "id:a4ayc_80_OEAAAAAAAAAXz",
      "size": 234567,
      "client_modified": "2024-06-14T08:00:00Z",
      "server_modified": "2024-06-14T08:01:00Z",
      "content_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ],
  "cursor": "ZtkX9_EHj3x7PMkVuFIhwKYXEpwpLwyxp9vMKomUhllil9q7eWiAu",
  "has_more": true
}
```

### Continue Listing
`POST /files/list_folder/continue`

Continues a folder listing from the previous cursor.

**Request body (JSON):**
```json
{
  "cursor": "ZtkX9_EHj3x7PMkVuFIhwKYXEpwpLwyxp9vMKomUhllil9q7eWiAu"
}
```

### Get File Metadata
`POST /files/get_metadata`

Returns metadata for a file or folder.

**Request body (JSON):**
```json
{
  "path": "/Documents/report.pdf"
}
```

### Download File
`POST https://content.dropboxapi.com/2/files/download`

Downloads a file. The file path is sent in the `Dropbox-API-Arg` header (JSON-encoded). Response body is the raw file content.

**Headers:**
- `Dropbox-API-Arg: {"path": "/Documents/report.pdf"}`

### Upload File
`POST https://content.dropboxapi.com/2/files/upload`

Uploads a file (up to 150MB). File metadata in `Dropbox-API-Arg` header, raw file content in request body. Requires `files.content.write` scope.

**Headers:**
- `Content-Type: application/octet-stream`
- `Dropbox-API-Arg: {"path": "/Documents/new-file.txt", "mode": "add", "autorename": true}`

### Search Files
`POST /files/search_v2`

Searches for files by name or content.

**Request body (JSON):**
```json
{
  "query": "quarterly report",
  "options": {
    "path": "/Documents",
    "max_results": 20,
    "file_extensions": ["pdf", "docx"]
  }
}
```

**Response:**
```json
{
  "matches": [
    {
      "metadata": {
        ".tag": "metadata",
        "metadata": {
          ".tag": "file",
          "name": "Q3-quarterly-report.pdf",
          "path_display": "/Documents/Q3-quarterly-report.pdf",
          "size": 345678
        }
      }
    }
  ],
  "has_more": false,
  "cursor": "..."
}
```

### Create Folder
`POST /files/create_folder_v2`

Creates a new folder. Requires `files.content.write` scope.

**Request body (JSON):**
```json
{
  "path": "/Documents/New Project",
  "autorename": false
}
```

### Delete File/Folder
`POST /files/delete_v2`

Deletes a file or folder. Requires `files.content.write` scope.

**Request body (JSON):**
```json
{
  "path": "/Documents/old-file.txt"
}
```

### Move File/Folder
`POST /files/move_v2`

Moves or renames a file or folder. Requires `files.content.write` scope.

**Request body (JSON):**
```json
{
  "from_path": "/Documents/report.pdf",
  "to_path": "/Archive/report.pdf",
  "autorename": false
}
```

### Copy File/Folder
`POST /files/copy_v2`

Copies a file or folder. Requires `files.content.write` scope.

**Request body (JSON):**
```json
{
  "from_path": "/Documents/template.docx",
  "to_path": "/Documents/new-doc.docx"
}
```

### List Shared Links
`POST /sharing/list_shared_links`

Lists shared links for a file or the entire account.

**Request body (JSON):**
```json
{
  "path": "/Documents/report.pdf"
}
```

**Response:**
```json
{
  "links": [
    {
      "url": "https://www.dropbox.com/s/abc123/report.pdf?dl=0",
      "name": "report.pdf",
      "path_lower": "/documents/report.pdf",
      ".tag": "file"
    }
  ],
  "has_more": false
}
```

## Common Patterns

### Pagination (Cursor-Based)
List endpoints use cursor-based pagination:
1. Call the initial endpoint (e.g. `/files/list_folder`)
2. Check `has_more` in response
3. If `true`, call the `/continue` variant with the `cursor`
4. Repeat until `has_more` is `false`

### Content Upload/Download
File content operations use a **separate domain**:
- Upload: `https://content.dropboxapi.com/2/files/upload`
- Download: `https://content.dropboxapi.com/2/files/download`

Metadata is passed in the `Dropbox-API-Arg` header (JSON string), and the request/response body contains raw file data.

### File Paths
- All paths start with `/` (root of user's Dropbox)
- Paths are case-insensitive (`path_lower` for comparison, `path_display` for display)
- Use `""` (empty string) to reference the root

### Error Format
```json
{
  "error_summary": "path/not_found/..",
  "error": {
    ".tag": "path",
    "path": {
      ".tag": "not_found"
    }
  }
}
```

## Important Notes
- **All API calls are POST** — even read operations. This is unique to Dropbox.
- `token_access_type: "offline"` must be passed during authorization to receive refresh tokens.
- File uploads up to 150MB use the simple upload endpoint. Larger files require upload sessions (`/files/upload_session/start`).
- Content operations use `content.dropboxapi.com`, not `api.dropboxapi.com`.
- The `.tag` field in responses indicates the entry type (`file`, `folder`, `deleted`).
- `content_hash` is a SHA-256 based hash for detecting file changes.
- Rate limit: no fixed rate, but excessive requests result in 429 errors with `Retry-After` header.
- `autorename: true` automatically renames files/folders to avoid conflicts.
