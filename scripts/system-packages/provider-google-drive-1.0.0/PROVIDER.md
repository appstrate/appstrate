# Google Drive API

Base URL: `https://www.googleapis.com/drive/v3`

## Quick Reference

Cloud file storage API. List, search, upload, download, and manage files and folders in Google Drive.

## Key Endpoints

### List Files
GET /files
Search and list files. Use `q` parameter for search queries.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: google-drive" \
  -H "X-Target: https://www.googleapis.com/drive/v3/files?pageSize=10&fields=files(id,name,mimeType,modifiedTime)" \
  -H "Authorization: Bearer {{access_token}}"
```

### Get File Metadata
GET /files/{fileId}
Retrieve metadata for a specific file.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: google-drive" \
  -H "X-Target: https://www.googleapis.com/drive/v3/files/{FILE_ID}?fields=id,name,mimeType,size,modifiedTime,parents" \
  -H "Authorization: Bearer {{access_token}}"
```

### Download File Content
GET /files/{fileId}?alt=media
Download the binary content of a file.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: google-drive" \
  -H "X-Target: https://www.googleapis.com/drive/v3/files/{FILE_ID}?alt=media" \
  -H "Authorization: Bearer {{access_token}}"
```

### Export Google Docs
GET /files/{fileId}/export
Export Google Workspace files (Docs, Sheets, Slides) to other formats.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: google-drive" \
  -H "X-Target: https://www.googleapis.com/drive/v3/files/{FILE_ID}/export?mimeType=text/plain" \
  -H "Authorization: Bearer {{access_token}}"
```

### Upload File (Simple)
POST /upload/drive/v3/files?uploadType=media
Upload a new file. For metadata+content, use `uploadType=multipart`.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: google-drive" \
  -H "X-Target: https://www.googleapis.com/upload/drive/v3/files?uploadType=media" \
  -H "Authorization: Bearer {{access_token}}" \
  -H "Content-Type: text/plain" \
  -d "File content here"
```

### Create Folder
POST /files
Create a folder (a file with mimeType `application/vnd.google-apps.folder`).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: google-drive" \
  -H "X-Target: https://www.googleapis.com/drive/v3/files" \
  -H "Authorization: Bearer {{access_token}}" \
  -H "Content-Type: application/json" \
  -d '{"name": "New Folder", "mimeType": "application/vnd.google-apps.folder"}'
```

### Delete File
DELETE /files/{fileId}
Permanently delete a file (bypasses trash).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X DELETE \
  -H "X-Provider: google-drive" \
  -H "X-Target: https://www.googleapis.com/drive/v3/files/{FILE_ID}" \
  -H "Authorization: Bearer {{access_token}}"
```

## Common Patterns

### Search Query Syntax (q parameter)
- `name = 'report.pdf'` -- exact name match
- `name contains 'report'` -- name contains string
- `mimeType = 'application/vnd.google-apps.folder'` -- folders only
- `'FOLDER_ID' in parents` -- files in specific folder
- `modifiedTime > '2024-01-01T00:00:00'` -- modified after date
- `trashed = false` -- exclude trashed files
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

## Important Notes

- Use `fields` parameter to avoid large responses that may be truncated by the sidecar (>50KB).
- Google Workspace files (Docs, Sheets) cannot be downloaded with `alt=media` -- use `/export` instead.
- The `drive.file` scope only grants access to files created by the app or explicitly shared with it.
- Rate limit: 12,000 queries per minute per project.