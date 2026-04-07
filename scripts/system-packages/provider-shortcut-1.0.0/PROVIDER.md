# Shortcut API

Base URL: `https://api.app.shortcut.com/api/v3`

Project management for software teams. Manage stories (issues), epics, iterations, and projects. Stories are the primary entity — they have a type (feature, bug, chore), belong to a workflow, and can be assigned to iterations and epics. Authentication uses the `Shortcut-Token` header.

## Endpoints

### Get Current Member
`GET /api/v3/member`

**Response:**
```json
{
  "id": "12345678-1234-1234-1234-123456789012",
  "mention_name": "johndoe",
  "profile": {
    "name": "John Doe",
    "email_address": "john@example.com"
  },
  "role": "admin",
  "disabled": false
}
```

### List Members
`GET /api/v3/members`

### List Workflows
`GET /api/v3/workflows`

Returns all workflows with their states.

**Response:**
```json
[
  {
    "id": 500000001,
    "name": "Default Workflow",
    "states": [
      { "id": 500000100, "name": "Unstarted", "type": "unstarted", "position": 0 },
      { "id": 500000101, "name": "In Development", "type": "started", "position": 1 },
      { "id": 500000102, "name": "Ready for Review", "type": "started", "position": 2 },
      { "id": 500000103, "name": "Done", "type": "done", "position": 3 }
    ]
  }
]
```

### Get Story
`GET /api/v3/stories/{STORY_ID}`

**Response:**
```json
{
  "id": 12345,
  "name": "Fix authentication bug",
  "story_type": "bug",
  "description": "Users are getting 403 errors when trying to login",
  "workflow_state_id": 500000101,
  "owner_ids": ["12345678-1234-1234-1234-123456789012"],
  "estimate": 3,
  "epic_id": 100,
  "iteration_id": 200,
  "project_id": "project-uuid",
  "labels": [{ "id": 300, "name": "backend" }],
  "deadline": "2024-03-15T00:00:00Z",
  "created_at": "2024-02-01T10:00:00Z",
  "updated_at": "2024-02-10T14:30:00Z",
  "app_url": "https://app.shortcut.com/myorg/story/12345"
}
```

### Create Story
`POST /api/v3/stories`

**Request body (JSON):**
```json
{
  "name": "Implement OAuth2 flow",
  "story_type": "feature",
  "description": "Add OAuth2 support with PKCE",
  "workflow_state_id": 500000100,
  "owner_ids": ["12345678-1234-1234-1234-123456789012"],
  "estimate": 5,
  "epic_id": 100,
  "iteration_id": 200,
  "labels": [{ "name": "backend" }],
  "deadline": "2024-04-01T00:00:00Z"
}
```

### Update Story
`PUT /api/v3/stories/{STORY_ID}`

**Request body (JSON):**
```json
{
  "workflow_state_id": 500000103,
  "estimate": 8,
  "owner_ids": ["12345678-1234-1234-1234-123456789012"]
}
```

### Delete Story
`DELETE /api/v3/stories/{STORY_ID}`

### Search Stories
`POST /api/v3/stories/search`

**Request body (JSON):**
```json
{
  "query": "login bug",
  "page_size": 25,
  "story_type": "bug",
  "workflow_state_types": ["started"],
  "owner_ids": ["12345678-1234-1234-1234-123456789012"]
}
```

**Response:**
```json
{
  "data": [
    {
      "id": 12345,
      "name": "Fix authentication bug",
      "story_type": "bug",
      "workflow_state_id": 500000101
    }
  ],
  "next": "eyJwYWdlIjoyfQ==",
  "total": 42
}
```

For next page, add `"next": "eyJwYWdlIjoyfQ=="` to the search body.

### List Epics
`GET /api/v3/epics`

**Response:**
```json
[
  {
    "id": 100,
    "name": "Authentication Overhaul",
    "state": "in progress",
    "started": true,
    "completed": false,
    "deadline": "2024-06-30T00:00:00Z",
    "stats": { "num_stories_started": 5, "num_stories_done": 3, "num_stories_total": 12 }
  }
]
```

### Create Epic
`POST /api/v3/epics`

**Request body (JSON):**
```json
{
  "name": "New Feature Set",
  "description": "All stories related to the new feature",
  "deadline": "2024-06-30T00:00:00Z"
}
```

### List Iterations (Sprints)
`GET /api/v3/iterations`

**Response:**
```json
[
  {
    "id": 200,
    "name": "Sprint 15",
    "status": "started",
    "start_date": "2024-02-12",
    "end_date": "2024-02-26",
    "stats": { "num_stories_started": 8, "num_stories_done": 3, "num_stories_total": 15 }
  }
]
```

### List Projects
`GET /api/v3/projects`

### List Labels
`GET /api/v3/labels`

### Create Label
`POST /api/v3/labels`

**Request body (JSON):**
```json
{
  "name": "critical",
  "color": "#ff0000"
}
```

### List Story Comments
`GET /api/v3/stories/{STORY_ID}/comments`

### Add Comment
`POST /api/v3/stories/{STORY_ID}/comments`

**Request body (JSON):**
```json
{
  "text": "Reviewed the PR. Looks good, merging now."
}
```

## Common Patterns

### Pagination
Most list endpoints return all results (no pagination). For search, use the `next` token: include it in the request body to get the next page. When `next` is `null`, all results have been returned.

### Story Types
- `feature` — New functionality
- `bug` — Defect/issue
- `chore` — Maintenance/infrastructure

### Workflow State Types
- `unstarted` — Not yet started
- `started` — Work in progress
- `done` — Completed

### Error Format
```json
{
  "message": "Resource not found",
  "errors": { "story_id": "not found" }
}
```

### Rate Limits
200 requests per minute. Header: `Shortcut-RateLimit-Remaining`. Returns 429 when exceeded.

## Important Notes
- **Shortcut-Token header** — Uses `Shortcut-Token` header (no prefix), not `Authorization: Bearer`.
- **Story IDs are numbers** — Story IDs are integers (e.g. `12345`), while other IDs (members, projects) are UUIDs.
- **No pagination on lists** — Most list endpoints return all items. Only search uses pagination.
- **Labels by name** — When creating stories, labels can be referenced by name: `{"name": "backend"}`.
- **Token permanent** — API tokens don't expire unless manually revoked.
- **Workflow states** — To change a story's status, update `workflow_state_id`. Get available states from `GET /workflows`.
- **Estimates** — Story estimates use a numeric point system (e.g. 1, 2, 3, 5, 8, 13).
