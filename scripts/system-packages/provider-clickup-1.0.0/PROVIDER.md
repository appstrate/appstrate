# ClickUp API

Base URL: `https://api.clickup.com/api/v2`

## Quick Reference

Project management API. Manage workspaces, spaces, folders, lists, and tasks.
Hierarchy: Workspace -> Space -> Folder -> List -> Task.

## Key Endpoints

### Get Workspaces (Teams)
GET /team
List workspaces the user belongs to.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: clickup" \
  -H "X-Target: https://api.clickup.com/api/v2/team" \
  -H "Authorization: Bearer {{token}}"
```

### Get Spaces
GET /team/{team_id}/space
List spaces in a workspace.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: clickup" \
  -H "X-Target: https://api.clickup.com/api/v2/team/{TEAM_ID}/space" \
  -H "Authorization: Bearer {{token}}"
```

### Get Lists
GET /folder/{folder_id}/list
List all lists in a folder.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: clickup" \
  -H "X-Target: https://api.clickup.com/api/v2/folder/{FOLDER_ID}/list" \
  -H "Authorization: Bearer {{token}}"
```

### Get Tasks
GET /list/{list_id}/task
List tasks in a list. Supports filtering by status, assignee, dates.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: clickup" \
  -H "X-Target: https://api.clickup.com/api/v2/list/{LIST_ID}/task?include_closed=true" \
  -H "Authorization: Bearer {{token}}"
```

### Create Task
POST /list/{list_id}/task
Create a new task in a list.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: clickup" \
  -H "X-Target: https://api.clickup.com/api/v2/list/{LIST_ID}/task" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d '{"name": "New Task", "description": "Task description", "status": "to do", "priority": 3}'
```

### Update Task
PUT /task/{task_id}
Update task properties.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X PUT \
  -H "X-Provider: clickup" \
  -H "X-Target: https://api.clickup.com/api/v2/task/{TASK_ID}" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d '{"status": "complete", "priority": 1}'
```

### Get Task
GET /task/{task_id}
Get full task details including custom fields.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: clickup" \
  -H "X-Target: https://api.clickup.com/api/v2/task/{TASK_ID}" \
  -H "Authorization: Bearer {{token}}"
```

### Get Task Comments
GET /task/{task_id}/comment
List comments on a task.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: clickup" \
  -H "X-Target: https://api.clickup.com/api/v2/task/{TASK_ID}/comment" \
  -H "Authorization: Bearer {{token}}"
```

## Common Patterns

### Pagination
Tasks use `page` parameter (0-based). Default 100 tasks per page.
Response includes `last_page: true` when no more results.

### Priority Values
- 1 = Urgent (red)
- 2 = High (orange)
- 3 = Normal (yellow)
- 4 = Low (blue)
- null = No priority

### Date Formats
ClickUp uses Unix timestamps in milliseconds.
- `due_date`: `1704067200000` (Jan 1 2024)
- `start_date`: same format

### Task Filtering
Query params on GET /list/{id}/task:
- `statuses[]=to%20do&statuses[]=in%20progress`
- `assignees[]=USER_ID`
- `due_date_gt=TIMESTAMP&due_date_lt=TIMESTAMP`
- `include_closed=true`

## Important Notes

- Workspace = "Team" in the API. The `team_id` is the workspace ID.
- Rate limit: 100 requests per minute per token.
- Custom fields are returned in the `custom_fields` array on tasks.
- Task IDs are unique globally (not scoped to list).
- Use `custom_task_ids=true` query param if you want to use custom IDs instead.