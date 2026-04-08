# Typeform API

Base URL: `https://api.typeform.com`

Online form builder API. Create forms, retrieve responses, manage workspaces, and configure webhooks. All endpoints require Bearer token authentication.

## Endpoints

### Get Current User
`GET /me`

Returns the authenticated user's account info.

**Response:**
```json
{
  "user_id": "abc123",
  "email": "john@example.com",
  "alias": "John Doe",
  "language": "en"
}
```

### List Forms
`GET /forms`

Returns all forms in the account.

**Query parameters:**
- `page` — Page number (1-indexed, default 1)
- `page_size` — Items per page (default 10, max 200)
- `search` — Search forms by title
- `workspace_id` — Filter by workspace

**Response:**
```json
{
  "total_items": 25,
  "page_count": 3,
  "items": [
    {
      "id": "abc123XYZ",
      "title": "Customer Feedback",
      "last_updated_at": "2024-06-15T10:30:00Z",
      "self": { "href": "https://api.typeform.com/forms/abc123XYZ" },
      "_links": {
        "display": "https://form.typeform.com/to/abc123XYZ"
      }
    }
  ]
}
```

### Get Form
`GET /forms/{formId}`

Returns the full form definition including all fields/questions.

**Response:**
```json
{
  "id": "abc123XYZ",
  "title": "Customer Feedback",
  "type": "quiz",
  "fields": [
    {
      "id": "field_001",
      "ref": "satisfaction_rating",
      "title": "How satisfied are you with our service?",
      "type": "rating",
      "properties": {
        "steps": 5,
        "shape": "star"
      },
      "validations": { "required": true }
    },
    {
      "id": "field_002",
      "ref": "comments",
      "title": "Any additional comments?",
      "type": "long_text",
      "validations": { "required": false }
    }
  ],
  "welcome_screens": [],
  "thankyou_screens": []
}
```

### Create Form
`POST /forms`

Creates a new form. Requires `forms:write` scope.

**Request body (JSON):**
```json
{
  "title": "Event Registration",
  "fields": [
    {
      "ref": "name",
      "title": "What is your name?",
      "type": "short_text",
      "validations": { "required": true }
    },
    {
      "ref": "email",
      "title": "What is your email?",
      "type": "email",
      "validations": { "required": true }
    }
  ]
}
```

### Update Form
`PUT /forms/{formId}`

Replaces the entire form definition. Requires `forms:write` scope.

### List Responses
`GET /forms/{formId}/responses`

Returns responses for a form. Requires `responses:read` scope.

**Query parameters:**
- `page_size` — Items per page (default 25, max 1000)
- `since` — Responses submitted after this date (ISO 8601)
- `until` — Responses submitted before this date
- `after` — Cursor for next page (response token from previous response)
- `before` — Cursor for previous page
- `completed` — Only completed responses (`true` or `false`)
- `sort` — `submitted_at,asc` or `submitted_at,desc`
- `query` — Search in response answers

**Response:**
```json
{
  "total_items": 156,
  "page_count": 7,
  "items": [
    {
      "landing_id": "abc123",
      "token": "resp_token_xyz",
      "response_id": "resp_001",
      "submitted_at": "2024-06-15T10:30:00Z",
      "landed_at": "2024-06-15T10:28:00Z",
      "metadata": {
        "user_agent": "Mozilla/5.0...",
        "platform": "desktop",
        "referer": "https://example.com",
        "network_id": "abc123"
      },
      "answers": [
        {
          "field": { "id": "field_001", "ref": "satisfaction_rating", "type": "rating" },
          "type": "number",
          "number": 4
        },
        {
          "field": { "id": "field_002", "ref": "comments", "type": "long_text" },
          "type": "text",
          "text": "Great service, very responsive team!"
        }
      ]
    }
  ]
}
```

### Delete Responses
`DELETE /forms/{formId}/responses`

Deletes specific responses. Requires `responses:write` scope. Deletion is asynchronous: a `200` response means the deletion request was accepted, not that deletion finished immediately.

**Query parameters:**
- `included_response_ids` — Comma-separated list of `response_id` values to delete (up to 1000)

**Request body (JSON, alternative):**
```json
{
  "included_response_ids": ["resp_001", "resp_002"]
}
```

### List Workspaces
`GET /workspaces`

Returns all workspaces. Requires `workspaces:read` scope.

**Response:**
```json
{
  "total_items": 3,
  "items": [
    {
      "id": "ws_abc123",
      "name": "Marketing",
      "forms": { "count": 12, "href": "https://api.typeform.com/workspaces/ws_abc123/forms" }
    }
  ]
}
```

### Create Webhook
`PUT /forms/{formId}/webhooks/{tag}`

Creates or updates a webhook for a form. Requires `webhooks:write` scope.

**Request body (JSON):**
```json
{
  "url": "https://example.com/webhook",
  "enabled": true
}
```

### List Webhooks
`GET /forms/{formId}/webhooks`

Returns all webhooks for a form.

## Common Patterns

### Pagination
Two pagination methods:
1. **Page-based** (forms, workspaces): `page` (1-indexed) + `page_size`
2. **Cursor-based** (responses): `after` token from previous response's last item `token`

For responses, the `token` field on each response item serves as the cursor for the `after` parameter.

### Field Types
Common Typeform field types:
- `short_text`, `long_text` — Text inputs
- `email`, `phone_number`, `website` — Validated inputs
- `multiple_choice`, `dropdown` — Selection
- `rating`, `opinion_scale` — Numeric scales
- `yes_no` — Boolean
- `date` — Date picker
- `number` — Numeric input
- `file_upload` — File upload
- `picture_choice` — Image-based selection

### Error Format
```json
{
  "code": "AUTHENTICATION_FAILED",
  "description": "Authentication credentials not found."
}
```

## Important Notes
- The `offline` scope is required to get refresh tokens — without it, tokens expire after a few hours.
- Form IDs are alphanumeric strings (e.g. `abc123XYZ`).
- Field references (`ref`) are user-defined strings that persist across form updates — use these instead of `id` for stable integrations.
- Responses include answer `type` that matches the field type (e.g. `number` for rating, `text` for text fields).
- `DELETE /forms/{formId}/responses` expects `included_response_ids`, not response tokens.
- Response deletion is asynchronous — verify deletion by listing responses again.
- Rate limit: 2 requests/second for responses endpoint, higher for other endpoints.
- Webhook payloads are signed with a secret (if configured) via `Typeform-Signature` header.
