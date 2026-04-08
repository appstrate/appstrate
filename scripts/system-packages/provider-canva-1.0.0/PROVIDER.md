# Canva API

Base URL: `https://api.canva.com/rest/v1`

Online graphic design platform API. Browse designs, export them to various formats, manage folders, upload assets, and work with brand templates. Uses PKCE-enabled OAuth2 with `client_secret_basic` for token exchange.

## Endpoints

### Get Current User
`GET /users/me`

Returns the authenticated user's profile. Requires `profile:read` scope.

**Response:**
```json
{
  "profile": {
    "display_name": "John Doe",
    "id": "oUnPjZ2k2yuhftbWF3sUhA"
  }
}
```

### List Designs
`GET /designs`

Returns the user's designs. Requires `design:meta:read` scope.

**Query parameters:**
- `continuation` — Cursor for next page
- `ownership` — Filter: `owned`, `shared`, `any` (default `owned`)
- `sort_by` — Sort: `relevance`, `modified_descending`, `modified_ascending`, `title_ascending`, `title_descending`
- `query` — Search by title

**Response:**
```json
{
  "items": [
    {
      "id": "DAFVztcvd98",
      "title": "Q3 Marketing Deck",
      "owner": { "user_id": "oUnPjZ2k2yuhftbWF3sUhA" },
      "thumbnail": {
        "width": 595,
        "height": 335,
        "url": "https://document-export.canva.com/..."
      },
      "urls": {
        "edit_url": "https://www.canva.com/design/DAFVztcvd98/edit",
        "view_url": "https://www.canva.com/design/DAFVztcvd98/view"
      },
      "created_at": 1718445600,
      "updated_at": 1718449200
    }
  ],
  "continuation": "eyJhZnRlciI6IkRBR..."
}
```

### Get Design
`GET /designs/{designId}`

Returns metadata for a specific design. Requires `design:meta:read` scope.

### Create Design
`POST /designs`

Creates a new design. Requires `design:content:write` scope.

**Request body (JSON):**
```json
{
  "design_type": {
    "type": "preset",
    "name": "Presentation"
  },
  "title": "New Presentation",
  "asset_id": "optional-template-asset-id"
}
```

**Response:**
```json
{
  "design": {
    "id": "DAFVztcvd99",
    "title": "New Presentation",
    "urls": {
      "edit_url": "https://www.canva.com/design/DAFVztcvd99/edit"
    },
    "created_at": 1718449200
  }
}
```

### Start Export Job
`POST /designs/{designId}/exports`

Starts an async export of a design to PDF, PNG, JPG, etc. Requires `design:content:read` scope.

**Request body (JSON):**
```json
{
  "format": {
    "type": "pdf",
    "size": "a4"
  },
  "pages": [1, 2, 3]
}
```

**Response:**
```json
{
  "job": {
    "id": "export_abc123",
    "status": "in_progress"
  }
}
```

### Get Export Job
`GET /designs/{designId}/exports/{exportId}`

Polls the status of an export job. When complete, provides a download URL.

**Response (completed):**
```json
{
  "job": {
    "id": "export_abc123",
    "status": "success",
    "urls": [
      "https://export-download.canva.com/..."
    ]
  }
}
```

### List Folders
`GET /folders`

Returns the user's folders. Requires `folder:read` scope.

**Query parameters:**
- `continuation` — Cursor for next page

**Response:**
```json
{
  "items": [
    {
      "id": "FAFxyz123",
      "name": "Marketing Materials",
      "created_at": 1718445600,
      "updated_at": 1718449200,
      "thumbnail": { "url": "https://..." }
    }
  ],
  "continuation": null
}
```

### List Folder Items
`GET /folders/{folderId}/items`

Returns items inside a specific folder.

**Query parameters:**
- `continuation` — Cursor for next page
- `item_types` — Filter: `design`, `folder`, `image`

### Upload Asset
`POST /assets/upload`

Uploads an image asset to the user's Canva account. Requires `asset:write` scope.

**Headers:**
- `Content-Type: multipart/form-data`

**Form fields:**
- `file` — The image file
- `name` — Asset name (optional)

**Response:**
```json
{
  "asset": {
    "id": "asset_abc123",
    "name": "logo.png",
    "tags": [],
    "created_at": 1718449200,
    "updated_at": 1718449200,
    "thumbnail": { "url": "https://..." }
  }
}
```

### List Brand Templates
`GET /brand-templates`

Returns available brand templates. Requires `brandtemplate:meta:read` scope.

**Query parameters:**
- `continuation` — Cursor for next page
- `query` — Search by title

**Response:**
```json
{
  "items": [
    {
      "id": "DAFVzt_template",
      "title": "Company Letterhead",
      "thumbnail": { "url": "https://..." },
      "created_at": 1718445600,
      "updated_at": 1718449200
    }
  ],
  "continuation": null
}
```

### Get Brand Template
`GET /brand-templates/{brandTemplateId}`

Returns details for a specific brand template.

### List Comments
`GET /designs/{designId}/comments`

Returns comments on a design. Requires `comment:read` scope.

**Response:**
```json
{
  "items": [
    {
      "id": "comment_abc123",
      "message": "Can we change the color to blue?",
      "author": {
        "user_id": "oUnPjZ2k2yuhftbWF3sUhA",
        "display_name": "Alice Martin"
      },
      "created_at": 1718449200,
      "updated_at": 1718449200
    }
  ]
}
```

## Common Patterns

### Pagination
Cursor-based pagination:
- Response includes `continuation` field
- Pass as `continuation` query parameter
- When `continuation` is `null`, no more pages

### Async Exports
Design export is asynchronous:
1. `POST /designs/{id}/exports` — Start export, get `job.id`
2. Poll `GET /designs/{id}/exports/{exportId}` until `status` is `success` or `failed`
3. Download from `urls` array in the completed response

Export statuses: `in_progress`, `success`, `failed`

### Error Format
```json
{
  "error": {
    "code": "not_found",
    "message": "The requested design could not be found."
  }
}
```

## Important Notes
- Uses `client_secret_basic` (HTTP Basic Auth) for token exchange.
- PKCE is required for the OAuth flow.
- Access tokens expire after 1 hour, refresh tokens after 6 months.
- Design export is async — you must poll for completion (typically a few seconds).
- Design dimensions are in pixels.
- File uploads use `multipart/form-data` (not JSON).
- Timestamps are Unix timestamps (seconds), not ISO 8601.
- Design types for creation: `Presentation`, `Poster`, `Instagram Post`, `A4 Document`, etc.
- Rate limits vary by endpoint — consult Canva's developer docs for specifics.
