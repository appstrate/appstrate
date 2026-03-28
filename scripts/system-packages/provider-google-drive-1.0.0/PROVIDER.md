# Google Drive API

Base URL: `https://www.googleapis.com/drive/v3`

Cloud file storage API. List, search, upload, download, and manage files and folders in Google Drive.

## Endpoints

### List Files
`GET /files`

Search and list files. Use `q` parameter for search queries.

**Query parameters:**
- `q` — Search query (see Search Query Syntax below)
- `pageSize` — Results per page (default 100, max 1000)
- `pageToken` — Token for next page of results
- `fields` — Partial response fields (see Fields Parameter below)
- `orderBy` — Sort order (e.g. `modifiedTime desc`, `name`)

**Response:**
```json
{
  "nextPageToken": "...",
  "files": [
    { "id": "...", "name": "report.pdf", "mimeType": "application/pdf", "modifiedTime": "2024-06-15T10:30:00Z", "size": "102400" }
  ]
}
```

### Get File Metadata
`GET /files/{FILE_ID}`

Retrieve metadata for a specific file.

**Query parameters:**
- `fields` — Partial response fields (e.g. `id,name,mimeType,size,modifiedTime,parents,webViewLink`)

### Download File Content
`GET /files/{FILE_ID}?alt=media`

Download the binary content of a file. Does not work for Google Workspace files (Docs, Sheets, Slides) — use the Export endpoint instead.

### Export Google Workspace Files
`GET /files/{FILE_ID}/export`

Export Google Workspace files (Docs, Sheets, Slides) to other formats.

**Query parameters:**
- `mimeType` — Target format (required). See Export Formats below.

### Upload File (Simple)
`POST https://www.googleapis.com/upload/drive/v3/files?uploadType=media`

Upload a new file with content only. Set `Content-Type` header to the file's MIME type.

For metadata+content in a single request, use `uploadType=multipart` with a multipart request body containing the metadata JSON part and the file content part.

### Upload File with Metadata (Multipart)
`POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`

Upload a file with metadata. Request body is multipart with two parts: JSON metadata and file content.

### Create File/Folder (Metadata Only)
`POST /files`

Create a file entry with metadata only (no content). Use this to create folders.

**Request body:**
```json
{
  "name": "New Folder",
  "mimeType": "application/vnd.google-apps.folder",
  "parents": ["{PARENT_FOLDER_ID}"]
}
```

### Update File Metadata
`PATCH /files/{FILE_ID}`

Update a file's metadata (name, parents, etc.).

**Request body:**
```json
{
  "name": "Renamed File.pdf"
}
```

### Delete File
`DELETE /files/{FILE_ID}`

Permanently delete a file (bypasses trash).

### Copy File
`POST /files/{FILE_ID}/copy`

Create a copy of a file.

**Request body:**
```json
{
  "name": "Copy of report.pdf",
  "parents": ["{FOLDER_ID}"]
}
```

## Common Patterns

### Search Query Syntax (q parameter)
- `name = 'report.pdf'` — exact name match
- `name contains 'report'` — name contains string
- `mimeType = 'application/vnd.google-apps.folder'` — folders only
- `'{FOLDER_ID}' in parents` — files in specific folder
- `modifiedTime > '2024-01-01T00:00:00'` — modified after date
- `trashed = false` — exclude trashed files
- Combine with `and`/`or`: `name contains 'report' and mimeType != 'application/vnd.google-apps.folder'`

### Fields Parameter
Always specify `fields` to reduce response size:
- List: `fields=nextPageToken,files(id,name,mimeType,modifiedTime,size)`
- Get: `fields=id,name,mimeType,size,parents,webViewLink`

### Pagination
Responses include `nextPageToken`. Pass as `pageToken` for the next page. Default page size is 100.

### Google Workspace MIME Types
- Document: `application/vnd.google-apps.document`
- Spreadsheet: `application/vnd.google-apps.spreadsheet`
- Presentation: `application/vnd.google-apps.presentation`
- Folder: `application/vnd.google-apps.folder`

### Export Formats
- Docs: `text/plain`, `text/html`, `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- Sheets: `text/csv`, `application/pdf`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- Slides: `application/pdf`, `application/vnd.openxmlformats-officedocument.presentationml.presentation`

## Important Notes

- Google Workspace files (Docs, Sheets, Slides) cannot be downloaded with `alt=media` — use `/export` instead.
- Always use the `fields` parameter to request only needed fields and keep responses small.
- The `drive.file` scope only grants access to files created by the app or explicitly shared with it.
- Rate limit: 12,000 queries per 60 seconds per project, and 12,000 per 60 seconds per user.
- Exported content is limited to 10 MB.
- File IDs are globally unique opaque strings.
