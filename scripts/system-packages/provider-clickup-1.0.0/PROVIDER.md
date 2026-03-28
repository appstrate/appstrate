# ClickUp API

Base URL: `https://api.clickup.com/api/v2`

Project management API. Manage workspaces, spaces, folders, lists, and tasks.

Hierarchy: Workspace (Team) → Space → Folder → List → Task.

## Endpoints

### Get Workspaces (Teams)
`GET /team`

List workspaces the user belongs to.

**Response:**
```json
{
  "teams": [
    { "id": "1234567", "name": "My Workspace", "members": [...] }
  ]
}
```

### Get Spaces
`GET /team/{TEAM_ID}/space`

List spaces in a workspace.

**Query parameters:**
- `archived` — Include archived spaces (`true`/`false`)

### Get Folders
`GET /space/{SPACE_ID}/folder`

List folders in a space.

**Query parameters:**
- `archived` — Include archived folders (`true`/`false`)

### Get Folderless Lists
`GET /space/{SPACE_ID}/list`

List lists that are directly in a space (not inside a folder).

### Get Lists
`GET /folder/{FOLDER_ID}/list`

List all lists in a folder.

### Get Tasks
`GET /list/{LIST_ID}/task`

List tasks in a list. Supports filtering by status, assignee, dates.

**Query parameters:**
- `page` — Page number (0-based)
- `include_closed` — Include closed tasks (`true`/`false`)
- `statuses[]` — Filter by status (repeatable, URL-encoded: `statuses[]=to%20do`)
- `assignees[]` — Filter by assignee user IDs (repeatable)
- `due_date_gt` — Due date greater than (Unix ms timestamp)
- `due_date_lt` — Due date less than (Unix ms timestamp)
- `order_by` — Sort field (`id`, `created`, `updated`, `due_date`)
- `subtasks` — Include subtasks (`true`/`false`)

**Response:**
```json
{
  "tasks": [
    {
      "id": "abc123",
      "name": "Task Name",
      "status": { "status": "to do", "type": "open" },
      "priority": { "id": "3", "priority": "normal" },
      "assignees": [...],
      "due_date": "1704067200000",
      "custom_fields": [...]
    }
  ],
  "last_page": false
}
```

### Get Task
`GET /task/{TASK_ID}`

Get full task details including custom fields.

**Query parameters:**
- `custom_task_ids` — Set `true` to use custom task IDs instead of ClickUp IDs
- `include_subtasks` — Include subtasks (`true`/`false`)

### Create Task
`POST /list/{LIST_ID}/task`

Create a new task in a list.

**Request body:**
```json
{
  "name": "New Task",
  "description": "Task description",
  "status": "to do",
  "priority": 3,
  "assignees": [12345],
  "due_date": 1704067200000,
  "start_date": 1703980800000,
  "tags": ["backend"]
}
```

### Update Task
`PUT /task/{TASK_ID}`

Update task properties. Only include fields to change.

**Request body:**
```json
{
  "status": "complete",
  "priority": 1,
  "name": "Updated Name"
}
```

### Delete Task
`DELETE /task/{TASK_ID}`

Delete a task permanently.

### Get Task Comments
`GET /task/{TASK_ID}/comment`

List comments on a task.

### Create Task Comment
`POST /task/{TASK_ID}/comment`

Add a comment to a task.

**Request body:**
```json
{
  "comment_text": "This is a comment"
}
```

### Get Custom Fields
`GET /list/{LIST_ID}/field`

Get custom field definitions for a list.

### Set Custom Field Value
`POST /task/{TASK_ID}/field/{FIELD_ID}`

Set a custom field value on a task.

**Request body (varies by field type):**
```json
{
  "value": "field value"
}
```

## Common Patterns

### Pagination
Tasks use the `page` parameter (0-based). Default 100 tasks per page. Response includes `last_page: true` when no more results.

### Priority Values
- `1` = Urgent (red)
- `2` = High (orange)
- `3` = Normal (yellow)
- `4` = Low (blue)
- `null` = No priority

### Date Formats
ClickUp uses Unix timestamps in **milliseconds**.
- `due_date`: `1704067200000` (Jan 1, 2024 00:00:00 UTC)
- `start_date`: same format

### Custom Fields
Custom fields are returned in the `custom_fields` array on tasks. Each has `id`, `name`, `type`, and `value`. Field types include `text`, `number`, `drop_down`, `date`, `checkbox`, `email`, `url`, etc.

## Important Notes

- "Workspace" = "Team" in the API. The `team_id` is the workspace ID.
- Rate limit: 100 requests per minute per token (Free/Unlimited/Business). Higher on Business Plus (1,000/min) and Enterprise (10,000/min).
- Task IDs are unique globally (not scoped to a list).
- Use `custom_task_ids=true` query parameter if you want to use custom IDs instead of ClickUp IDs.
- Status names are case-sensitive and must match the list's configured statuses exactly.
