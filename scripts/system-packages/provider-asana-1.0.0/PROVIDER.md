# Asana API

Base URL: `https://app.asana.com/api/1.0`

Work management platform for teams. Manage tasks, projects, and workspaces. All responses are wrapped in a `{ "data": ... }` envelope. Use the `opt_fields` parameter to control which fields are returned — without it, responses contain only minimal data.

## Endpoints

### Get Current User
`GET /users/me`

**Query parameters:**
- `opt_fields` — Comma-separated fields (e.g. `name,email,workspaces.name`)

**Response:**
```json
{
  "data": {
    "gid": "1234567890",
    "name": "John Doe",
    "email": "john@example.com",
    "workspaces": [
      { "gid": "9876543210", "name": "My Workspace" }
    ]
  }
}
```

### List Workspaces
`GET /workspaces`

**Response:**
```json
{
  "data": [
    { "gid": "9876543210", "name": "My Workspace" }
  ]
}
```

### List Projects
`GET /projects`

**Query parameters:**
- `workspace` — Workspace GID (required)
- `opt_fields` — e.g. `name,owner.name,due_on,color,archived`
- `limit` — Max 100
- `offset` — Pagination token from previous response

**Response:**
```json
{
  "data": [
    {
      "gid": "1122334455",
      "name": "Product Launch",
      "owner": { "gid": "1234567890", "name": "John Doe" },
      "due_on": "2024-03-15",
      "archived": false
    }
  ],
  "next_page": {
    "offset": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9",
    "path": "/projects?workspace=9876543210&offset=eyJ0eXAi...",
    "uri": "https://app.asana.com/api/1.0/projects?workspace=9876543210&offset=eyJ0eXAi..."
  }
}
```

### Get Project
`GET /projects/{PROJECT_GID}`

**Query parameters:**
- `opt_fields` — e.g. `name,notes,owner.name,members.name,due_on`

### Create Project
`POST /projects`

**Request body (JSON):**
```json
{
  "data": {
    "name": "New Project",
    "workspace": "9876543210",
    "notes": "Project description here",
    "due_on": "2024-06-30",
    "color": "light-green"
  }
}
```

### List Tasks
`GET /tasks`

**Query parameters:**
- `project` — Project GID (or use `assignee` + `workspace`)
- `assignee` — User GID or `me`
- `workspace` — Workspace GID (required with `assignee`)
- `completed_since` — ISO date to filter completed tasks
- `opt_fields` — e.g. `name,completed,assignee.name,due_on,notes`
- `limit` — Max 100
- `offset` — Pagination token

### Get Task
`GET /tasks/{TASK_GID}`

**Query parameters:**
- `opt_fields` — e.g. `name,notes,html_notes,completed,assignee.name,due_on,projects.name,tags.name`

**Response:**
```json
{
  "data": {
    "gid": "5566778899",
    "name": "Design homepage mockup",
    "completed": false,
    "assignee": { "gid": "1234567890", "name": "John Doe" },
    "due_on": "2024-02-20",
    "notes": "Create the initial mockup for the new homepage",
    "projects": [{ "gid": "1122334455", "name": "Product Launch" }],
    "tags": [{ "gid": "111222333", "name": "design" }]
  }
}
```

### Create Task
`POST /tasks`

**Request body (JSON):**
```json
{
  "data": {
    "name": "Write documentation",
    "projects": ["1122334455"],
    "assignee": "1234567890",
    "due_on": "2024-02-28",
    "notes": "Write the API documentation for the new feature",
    "workspace": "9876543210"
  }
}
```

### Update Task
`PUT /tasks/{TASK_GID}`

**Request body (JSON):**
```json
{
  "data": {
    "completed": true,
    "due_on": "2024-03-01"
  }
}
```

### Delete Task
`DELETE /tasks/{TASK_GID}`

### List Sections
`GET /projects/{PROJECT_GID}/sections`

**Response:**
```json
{
  "data": [
    { "gid": "444555666", "name": "To Do" },
    { "gid": "444555667", "name": "In Progress" },
    { "gid": "444555668", "name": "Done" }
  ]
}
```

### Add Task to Section
`POST /sections/{SECTION_GID}/addTask`

**Request body (JSON):**
```json
{
  "data": {
    "task": "5566778899"
  }
}
```

### List Stories (Comments/Activity)
`GET /tasks/{TASK_GID}/stories`

**Query parameters:**
- `opt_fields` — e.g. `text,created_by.name,created_at,type`

### Add Comment
`POST /tasks/{TASK_GID}/stories`

**Request body (JSON):**
```json
{
  "data": {
    "text": "This looks great! Let's proceed."
  }
}
```

### Search Tasks
`GET /workspaces/{WORKSPACE_GID}/tasks/search`

**Query parameters:**
- `text` — Search text
- `assignee.any` — Filter by assignee GIDs
- `projects.any` — Filter by project GIDs
- `completed` — `true` or `false`
- `is_subtask` — `true` or `false`
- `sort_by` — `modified_at`, `created_at`, `completed_at`, `likes`
- `opt_fields` — Fields to return

## Common Patterns

### Pagination
Cursor-based. Responses include `next_page.offset` when more pages exist. Pass the `offset` value as a query parameter. When `next_page` is `null`, there are no more results. Max `limit` is 100.

### opt_fields
Always specify `opt_fields` to control returned fields. Without it, only `gid` and `name` are returned. Nested fields use dot notation: `assignee.name`, `projects.name`.

### Data Envelope
All responses wrap data in `{ "data": ... }`. Create/update requests also wrap the body in `{ "data": ... }`.

### Rich Text
Task descriptions support both plain text (`notes`) and HTML (`html_notes`). Use `html_notes` for formatted content.

### Error Format
```json
{
  "errors": [
    {
      "message": "project: Missing input",
      "help": "For more information on API status codes and how to handle them, read the docs on errors: https://developers.asana.com/docs/errors"
    }
  ]
}
```

### Rate Limits
Approximately 1500 requests per minute. Headers: `X-RateLimit-Limit`, `Retry-After`. Returns 429 when exceeded.

## Important Notes
- **GIDs** — All IDs are Global IDs (numeric strings like `"1234567890"`). Always use as strings.
- **opt_fields required** — Without `opt_fields`, responses are minimal. Always specify the fields you need.
- **Data envelope** — All request bodies must be wrapped in `{ "data": { ... } }`.
- **Token refresh** — Access tokens expire after 1 hour. Automatic refresh via the runtime.
- **Sections as status** — Asana uses sections within projects as status columns (like Kanban boards).
- **Subtasks** — Create subtasks by setting `parent` field to the parent task GID.
