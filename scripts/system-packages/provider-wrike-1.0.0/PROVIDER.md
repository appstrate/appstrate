# Wrike API

Base URL: `https://www.wrike.com/api/v4`

Collaborative work management platform. Manage tasks, folders, projects, and timelogs. Responses are wrapped in `{ "kind": "...", "data": [...] }`. Task statuses use `customStatusId` that must be resolved via the workflows endpoint.

## Endpoints

### Get Account Info
`GET /account`

**Response:**
```json
{
  "kind": "accounts",
  "data": [
    {
      "id": "IEAABCDE",
      "name": "My Company",
      "dateFormat": "MM/dd/yyyy",
      "firstDayOfWeek": "Mon"
    }
  ]
}
```

### Get Current User
`GET /contacts?me=true`

**Response:**
```json
{
  "kind": "contacts",
  "data": [
    {
      "id": "KUAABCDE",
      "firstName": "John",
      "lastName": "Doe",
      "type": "Person",
      "profiles": [{ "accountId": "IEAABCDE", "email": "john@example.com", "role": "User" }]
    }
  ]
}
```

### List Folders & Projects
`GET /folders`

**Query parameters:**
- `project` — `true` to filter only projects
- `fields` — Extra fields: `metadata,hasAttachments,briefDescription`

**Response:**
```json
{
  "kind": "folders",
  "data": [
    {
      "id": "IEAABCDEI2AAAAAA",
      "title": "Product Development",
      "scope": "WsFolder",
      "project": {
        "authorId": "KUAABCDE",
        "status": "Green",
        "startDate": "2024-01-01",
        "endDate": "2024-06-30"
      },
      "childIds": ["IEAABCDEI2AAAAAB", "IEAABCDEI2AAAAAC"]
    }
  ]
}
```

### Get Folder
`GET /folders/{FOLDER_ID}`

### Create Folder/Project
`POST /folders/{PARENT_FOLDER_ID}/folders`

**Request body (JSON):**
```json
{
  "title": "New Project",
  "description": "Project description",
  "project": {
    "status": "Green",
    "startDate": "2024-03-01",
    "endDate": "2024-09-30"
  }
}
```

### Update Folder
`PUT /folders/{FOLDER_ID}`

### List Tasks
`GET /tasks`

**Query parameters:**
- `status` — `Active`, `Completed`, `Deferred`, `Cancelled`
- `folderId` — Filter by folder
- `responsibles` — Filter by assignee contact IDs (comma-separated)
- `startDate` — Filter tasks starting after (YYYY-MM-DD)
- `dueDate` — Filter tasks due before (YYYY-MM-DD)
- `pageSize` — Max results (default 100, max 1000)
- `nextPageToken` — Pagination token
- `fields` — Extra fields: `recurrent,attachmentCount,briefDescription`

**Response:**
```json
{
  "kind": "tasks",
  "data": [
    {
      "id": "IEAABCDEKQAAAAAA",
      "title": "Design homepage mockup",
      "status": "Active",
      "importance": "High",
      "dates": {
        "type": "Planned",
        "start": "2024-02-01",
        "due": "2024-02-15"
      },
      "scope": "WsTask",
      "customStatusId": "IEAABCDEJMAAAAAT",
      "responsibleIds": ["KUAABCDE"],
      "parentIds": ["IEAABCDEI2AAAAAA"],
      "permalink": "https://www.wrike.com/open.htm?id=123456789"
    }
  ],
  "nextPageToken": "eyJsYXN0SWQiOiJJRUFBQkNERS..."
}
```

### Get Task
`GET /tasks/{TASK_ID}`

### Create Task
`POST /folders/{FOLDER_ID}/tasks`

**Request body (JSON):**
```json
{
  "title": "Implement login page",
  "description": "Build the new login page with OAuth support",
  "status": "Active",
  "importance": "High",
  "dates": {
    "start": "2024-02-20",
    "due": "2024-03-05",
    "type": "Planned"
  },
  "responsibles": ["KUAABCDE"],
  "customStatus": "IEAABCDEJMAAAAAT"
}
```

### Update Task
`PUT /tasks/{TASK_ID}`

**Request body (JSON):**
```json
{
  "title": "Updated title",
  "customStatus": "IEAABCDEJMAAAAAT",
  "importance": "Normal"
}
```

### Delete Task
`DELETE /tasks/{TASK_ID}`

### List Comments
`GET /tasks/{TASK_ID}/comments`

**Response:**
```json
{
  "kind": "comments",
  "data": [
    {
      "id": "IEAABCDEIMAAAAAQ",
      "authorId": "KUAABCDE",
      "text": "Design review completed. Looks good!",
      "createdDate": "2024-02-10T14:30:00Z"
    }
  ]
}
```

### Add Comment
`POST /tasks/{TASK_ID}/comments`

**Request body (JSON):**
```json
{
  "text": "Started working on this. ETA: Friday."
}
```

### List Contacts (Users)
`GET /contacts`

### Get Workflows
`GET /workflows`

Returns all workflows with their custom statuses.

**Response:**
```json
{
  "kind": "workflows",
  "data": [
    {
      "id": "IEAABCDEK4AAAAAA",
      "name": "Default Workflow",
      "standard": true,
      "customStatuses": [
        { "id": "IEAABCDEJMAAAAAT", "name": "New", "color": "Blue", "group": "Active" },
        { "id": "IEAABCDEJMAAAAU", "name": "In Progress", "color": "Yellow", "group": "Active" },
        { "id": "IEAABCDEJMAAAAV", "name": "Done", "color": "Green", "group": "Completed" }
      ]
    }
  ]
}
```

### Create Timelog
`POST /tasks/{TASK_ID}/timelogs`

**Request body (JSON):**
```json
{
  "hours": 2.5,
  "trackedDate": "2024-02-15",
  "comment": "Worked on implementation"
}
```

### List Timelogs
`GET /tasks/{TASK_ID}/timelogs`

## Common Patterns

### Pagination
Token-based: responses include `nextPageToken` when more data exists. Pass it as a query parameter. Max `pageSize` is 1000.

### Custom Statuses
Task statuses are managed via workflows. To change a status:
1. `GET /workflows` to find the `customStatusId`
2. `PUT /tasks/{id}` with `customStatus: "{customStatusId}"`

### IDs
All Wrike IDs are alphanumeric strings with a prefix (e.g. `IEAABCDEKQAAAAAA`). They are globally unique.

### Error Format
```json
{
  "errorDescription": "Resource not found",
  "error": "not_found"
}
```

### Rate Limits
400 requests per minute. Header `X-Rate-Limit-Remaining`. Returns 429 with `Retry-After` header when exceeded.

## Important Notes
- **Custom statuses** — Task status is a `customStatusId`, not a readable string. Use `GET /workflows` to resolve status names.
- **Token refresh** — Access tokens expire after 1 hour. Automatic refresh via the runtime.
- **Scope separator** — Wrike uses commas to separate scopes.
- **Folders vs Projects** — Projects are folders with `project` metadata. Use `?project=true` to filter.
- **Date types** — Task dates have a `type`: `Planned` (has start/due), `Backlog` (no dates), `Milestone` (single date).
- **Enterprise hosts** — Some Enterprise accounts use custom hosts. The `authorizedUris` wildcard covers them.
- **Importance levels** — `High`, `Normal`, `Low`.
