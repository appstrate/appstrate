# Teamwork API

Base URL: `https://{subdomain}.teamwork.com/projects/api/v3`

Project management platform for client work. The subdomain is specific to each account. All endpoints use the `.json` suffix. Responses use a JSON:API-like envelope with `included` for sideloaded data.

## Endpoints

### Get Current User

`GET /projects/api/v3/me.json`

**Response:**

```json
{
  "person": {
    "id": 12345,
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "company": { "id": 100, "name": "My Company" },
    "administrator": true
  }
}
```

### List Projects

`GET /projects/api/v3/projects.json`

**Query parameters:**

- `page` — Page number (starts at 1)
- `pageSize` — Results per page (max 500)
- `searchTerm` — Search by name
- `status` — `active`, `current`, `late`, `completed`, `archived`
- `fields[projects]` — Fields to return (e.g. `name,description,status,startDate,endDate`)

**Response:**

```json
{
  "projects": [
    {
      "id": 1001,
      "name": "Website Redesign",
      "description": "Complete redesign of the company website",
      "status": "active",
      "startDate": "2024-01-15",
      "endDate": "2024-06-30",
      "createdAt": "2024-01-10T09:00:00Z",
      "company": { "id": 200, "name": "Client Corp" }
    }
  ],
  "meta": {
    "page": {
      "pageOffset": 0,
      "pageSize": 50,
      "count": 1,
      "hasMore": false
    }
  }
}
```

### Get Project

`GET /projects/api/v3/projects/{PROJECT_ID}.json`

### Create Project

`POST /projects/api/v3/projects.json`

**Request body (JSON):**

```json
{
  "project": {
    "name": "New Client Project",
    "description": "Project description",
    "companyId": 200,
    "startDate": "2024-03-01",
    "endDate": "2024-09-30"
  }
}
```

### List Task Lists

`GET /projects/api/v3/projects/{PROJECT_ID}/tasklists.json`

**Response:**

```json
{
  "tasklists": [
    {
      "id": 2001,
      "name": "Sprint 1 Tasks",
      "projectId": 1001,
      "complete": false
    }
  ]
}
```

### Create Task List

`POST /projects/api/v3/projects/{PROJECT_ID}/tasklists.json`

**Request body (JSON):**

```json
{
  "tasklist": {
    "name": "Sprint 2 Tasks"
  }
}
```

### List Tasks

`GET /projects/api/v3/tasks.json`

**Query parameters:**

- `page`, `pageSize`
- `projectIds` — Filter by project IDs (comma-separated)
- `status` — `active`, `completed`, `all` (default `active`)
- `assignedToUserIds` — Filter by assignee
- `include` — Sideload: `tags,assignees,columns`
- `fields[tasks]` — e.g. `name,description,status,startDate,dueDate,priority`

**Response:**

```json
{
  "tasks": [
    {
      "id": 3001,
      "name": "Design mockups",
      "description": "Create initial design mockups",
      "status": "active",
      "priority": "high",
      "startDate": "2024-02-01",
      "dueDate": "2024-02-15",
      "progress": 50,
      "projectId": 1001,
      "tasklistId": 2001,
      "assigneeUserIds": [12345],
      "createdAt": "2024-01-20T10:00:00Z",
      "updatedAt": "2024-02-05T14:30:00Z"
    }
  ],
  "included": {
    "tags": { "101": { "id": 101, "name": "design", "color": "#ff6600" } }
  },
  "meta": {
    "page": { "pageOffset": 0, "pageSize": 50, "count": 1, "hasMore": false }
  }
}
```

### Get Task

`GET /projects/api/v3/tasks/{TASK_ID}.json`

### Create Task

`POST /projects/api/v3/tasklists/{TASKLIST_ID}/tasks.json`

**Request body (JSON):**

```json
{
  "task": {
    "name": "Implement login page",
    "description": "Build the new login page with OAuth support",
    "priority": "high",
    "startDate": "2024-02-20",
    "dueDate": "2024-03-05",
    "assigneeUserIds": [12345],
    "tags": [{ "name": "frontend" }]
  }
}
```

### Update Task

`PUT /projects/api/v3/tasks/{TASK_ID}.json`

**Request body (JSON):**

```json
{
  "task": {
    "status": "completed",
    "progress": 100
  }
}
```

### Delete Task

`DELETE /projects/api/v3/tasks/{TASK_ID}.json`

### List Comments

`GET /projects/api/v3/tasks/{TASK_ID}/comments.json`

### Add Comment

`POST /projects/api/v3/tasks/{TASK_ID}/comments.json`

**Request body (JSON):**

```json
{
  "comment": {
    "body": "Design review completed. Ready for development."
  }
}
```

### Log Time

`POST /projects/api/v3/tasks/{TASK_ID}/time.json`

**Request body (JSON):**

```json
{
  "timelog": {
    "hours": 2,
    "minutes": 30,
    "date": "2024-02-15",
    "description": "Worked on implementation"
  }
}
```

### List Time Entries

`GET /projects/api/v3/time.json`

**Query parameters:**

- `page`, `pageSize`
- `projectIds` — Filter by project
- `fromDate`, `toDate` — Date range (YYYY-MM-DD)

### List People

`GET /projects/api/v3/people.json`

### List Milestones

`GET /projects/api/v3/milestones.json`

**Query parameters:**

- `projectIds` — Filter by project

## Common Patterns

### Pagination

Page-based: `page` + `pageSize` (max 500). Check `meta.page.hasMore` for more pages.

### Included (Sideloading)

Use `include` parameter to sideload related data. Related objects appear in the `included` object keyed by type and ID.

### Field Selection

Use `fields[{type}]` to limit returned fields: `fields[tasks]=name,status,dueDate`

### Status Values

- Tasks: `new`, `active`, `completed`, `deleted`
- Projects: `active`, `current`, `late`, `completed`, `archived`

### Priority Values

`none`, `low`, `medium`, `high`

### Error Format

```json
{
  "status": "error",
  "MESSAGE": "Resource not found"
}
```

### Rate Limits

150 requests per minute (Free/Pro), 300 per minute (Enterprise). Headers: `X-Rate-Limit-Remaining`. Returns 429 when exceeded.

## Important Notes

- **Subdomain in URL** — The base URL includes the customer's subdomain (e.g. `mycompany.teamwork.com`). Use the `subdomain` credential field. Because the subdomain is dynamic, this provider uses `allowAllUris` to bypass the sidecar URI allowlist.
- **JSON suffix** — All endpoints require `.json` suffix. Without it, you may get HTML responses.
- **Basic auth** — Authentication is pre-encoded as `base64(api_key:X)` by the runtime.
- **Token permanent** — API keys don't expire unless manually revoked.
- **Request wrapping** — Create/update requests wrap the body in the entity name (e.g. `{ "task": { ... } }`).
- **Progress tracking** — Tasks have a `progress` field (0-100) for completion percentage.
- **API versions** — Some features may only be available in v1 (`/projects/api/v1/`). Use v3 for most operations.
