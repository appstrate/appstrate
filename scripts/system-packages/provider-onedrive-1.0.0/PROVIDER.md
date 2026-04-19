# OneDrive API

Base URL: `https://graph.microsoft.com/v1.0`

Microsoft OneDrive file storage API via Microsoft Graph. Browse, upload, download, and manage files and folders. Supports both personal OneDrive and OneDrive for Business (SharePoint). Uses OData query parameters.

## Endpoints

### Get User Drive
`GET /me/drive`

Returns the authenticated user's default drive metadata.

**Response:**
```json
{
  "id": "b!-RIj2DuyvEyV1T4NlOaMHk8XkS_I...",
  "driveType": "personal",
  "name": "OneDrive",
  "owner": {
    "user": {
      "displayName": "John Doe",
      "id": "48d31887-..."
    }
  },
  "quota": {
    "total": 5368709120,
    "used": 1073741824,
    "remaining": 4294967296
  }
}
```

### List Root Folder Items
`GET /me/drive/root/children`

Returns items in the root folder of the user's OneDrive.

**Query parameters:**
- `$top` — Items per page (max 200)
- `$select` — Fields to return (e.g. `name,size,lastModifiedDateTime`)
- `$orderby` — Sort (e.g. `name asc`, `lastModifiedDateTime desc`)
- `$filter` — Filter items

**Response:**
```json
{
  "value": [
    {
      "id": "01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K",
      "name": "Documents",
      "folder": { "childCount": 15 },
      "size": 0,
      "lastModifiedDateTime": "2024-06-15T10:30:00Z",
      "webUrl": "https://onedrive.live.com/..."
    },
    {
      "id": "01BYE5RZ5MYLM2SMX75ZBIPQZIHT6OAYPB",
      "name": "report.pdf",
      "file": { "mimeType": "application/pdf" },
      "size": 234567,
      "lastModifiedDateTime": "2024-06-14T08:15:00Z"
    }
  ],
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=..."
}
```

### List Folder Items
`GET /me/drive/items/{itemId}/children`

Returns items inside a specific folder.

### Get Item by Path
`GET /me/drive/root:/{path}`

Returns metadata for a file or folder by its path.

**Example:** `GET /me/drive/root:/Documents/report.pdf`

### Get Item by ID
`GET /me/drive/items/{itemId}`

Returns metadata for a file or folder by its ID.

### Download File
`GET /me/drive/items/{itemId}/content`

Downloads the file content. Returns a `302` redirect to a temporary download URL.

### Download File by Path
`GET /me/drive/root:/{path}:/content`

Downloads file by path. Returns a `302` redirect.

**Example:** `GET /me/drive/root:/Documents/report.pdf:/content`

### Upload Small File
`PUT /me/drive/items/{parentId}:/{filename}:/content`

Uploads a file up to 4MB. The request body is the raw file content.

**Headers:**
- `Content-Type` — MIME type of the file

**Example:** `PUT /me/drive/items/root::/Documents/notes.txt:/content`

### Create Upload Session (Large Files)
`POST /me/drive/items/{parentId}:/{filename}:/createUploadSession`

Creates a resumable upload session for files larger than 4MB.

**Request body (JSON):**
```json
{
  "item": {
    "@microsoft.graph.conflictBehavior": "rename",
    "name": "large-report.zip"
  }
}
```

**Response:**
```json
{
  "uploadUrl": "https://sn3302.up.1drv.com/up/fe6987415ace7X4e1eF866337...",
  "expirationDateTime": "2024-06-16T10:30:00.000Z"
}
```

Then upload file in chunks via `PUT` to `uploadUrl` with `Content-Range` headers.

### Create Folder
`POST /me/drive/items/{parentId}/children`

Creates a new folder. Requires `Files.ReadWrite` scope.

**Request body (JSON):**
```json
{
  "name": "New Project",
  "folder": {},
  "@microsoft.graph.conflictBehavior": "rename"
}
```

### Delete Item
`DELETE /me/drive/items/{itemId}`

Moves a file or folder to the recycle bin. Requires `Files.ReadWrite` scope.

### Move/Rename Item
`PATCH /me/drive/items/{itemId}`

Renames or moves an item. Requires `Files.ReadWrite` scope.

**Request body (rename):**
```json
{
  "name": "new-name.pdf"
}
```

**Request body (move):**
```json
{
  "parentReference": {
    "id": "new-parent-folder-id"
  }
}
```

### Search Files
`GET /me/drive/root/search(q='{query}')`

Searches for files by name or content.

**Query parameters:**
- `$top` — Max results per page
- `$select` — Fields to return

**Response:**
```json
{
  "value": [
    {
      "id": "01BYE5RZ...",
      "name": "quarterly-report.xlsx",
      "file": { "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      "size": 45678,
      "searchResult": { "onClickTelemetryUrl": "..." }
    }
  ]
}
```

### List Shared Items
`GET /me/drive/sharedWithMe`

Returns files and folders shared with the current user.

## Common Patterns

### Pagination
Cursor-based pagination with `@odata.nextLink`:
- Response includes `@odata.nextLink` URL for next page
- Follow the URL directly
- When no `@odata.nextLink`, no more pages

### Path Syntax
OneDrive uses a colon syntax for path-based access:
- Item by path: `/me/drive/root:/{path}`
- Content by path: `/me/drive/root:/{path}:/content`
- Children by path: `/me/drive/root:/{path}:/children`

Paths are relative to the drive root and use forward slashes.

### Conflict Behavior
When uploading or creating items, use `@microsoft.graph.conflictBehavior`:
- `rename` — Auto-rename if a file with the same name exists
- `replace` — Overwrite the existing file
- `fail` — Return an error if a file exists

### Error Format
```json
{
  "error": {
    "code": "itemNotFound",
    "message": "The resource could not be found.",
    "innerError": {
      "date": "2024-06-15T10:30:00",
      "request-id": "abc123-def456"
    }
  }
}
```

## Important Notes
- `offline_access` scope is required for refresh tokens.
- Items are identified by either `id` (opaque string) or `path` (colon syntax).
- Files ≤4MB can be uploaded with a simple `PUT`. Files >4MB require upload sessions.
- Download endpoints return `302` redirects — follow the redirect to get the file content.
- `driveType` values: `personal` (OneDrive), `business` (OneDrive for Business), `documentLibrary` (SharePoint).
- Rate limit: 10,000 requests per 10 minutes per app.
- Items in `folder` have a `folder` property. Items that are files have a `file` property with `mimeType`.
- Deleted items go to the recycle bin and can be restored via `/me/drive/items/{itemId}/restore`.
