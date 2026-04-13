# Basecamp API

Base URL: `https://3.basecampapi.com/{ACCOUNT_ID}`

Project management and team communication platform. Before making API calls, retrieve accessible accounts via the Launchpad API to get the `ACCOUNT_ID`. All endpoints require the `.json` suffix. Content uses HTML format, not Markdown. A descriptive `User-Agent` header is required.

## Endpoints

### Get Accessible Accounts
`GET https://launchpad.37signals.com/authorization.json`

Returns accounts accessible with the current token. Use the `id` as `ACCOUNT_ID`.

**Response:**
```json
{
  "accounts": [
    {
      "product": "bc3",
      "id": 9999999,
      "name": "My Company",
      "href": "https://3.basecampapi.com/9999999",
      "app_href": "https://3.basecamp.com/9999999"
    }
  ],
  "identity": {
    "id": 12345,
    "email_address": "john@example.com",
    "first_name": "John",
    "last_name": "Doe"
  }
}
```

### Get My Profile
`GET /my/profile.json`

**Response:**
```json
{
  "id": 12345,
  "name": "John Doe",
  "email_address": "john@example.com",
  "avatar_url": "https://...",
  "admin": true,
  "created_at": "2024-01-01T00:00:00Z"
}
```

### List Projects
`GET /projects.json`

**Query parameters:**
- `status` — `active` (default), `archived`, `trashed`

**Response:**
```json
[
  {
    "id": 1234567,
    "name": "Product Launch Q2",
    "description": "Launch the new product line",
    "purpose": "topic",
    "created_at": "2024-01-15T09:00:00Z",
    "updated_at": "2024-02-01T14:30:00Z",
    "bookmark_url": "https://3.basecampapi.com/9999999/my/bookmarks/BAh7CEk...",
    "dock": [
      { "id": 111111, "title": "Message Board", "name": "message_board", "enabled": true, "url": "https://3.basecampapi.com/9999999/buckets/1234567/message_boards/111111.json" },
      { "id": 222222, "title": "To-dos", "name": "todoset", "enabled": true, "url": "https://3.basecampapi.com/9999999/buckets/1234567/todosets/222222.json" },
      { "id": 333333, "title": "Schedule", "name": "schedule", "enabled": true, "url": "https://3.basecampapi.com/9999999/buckets/1234567/schedules/333333.json" }
    ]
  }
]
```

### Get Project
`GET /projects/{PROJECT_ID}.json`

### Create Project
`POST /projects.json`

**Request body (JSON):**
```json
{
  "name": "New Project",
  "description": "Project description in <strong>HTML</strong>"
}
```

### List To-do Lists
`GET /buckets/{PROJECT_ID}/todosets/{TODOSET_ID}/todolists.json`

The `TODOSET_ID` is found in the project's `dock` array.

**Response:**
```json
[
  {
    "id": 444444,
    "title": "Sprint Tasks",
    "completed": false,
    "completed_ratio": "3/10",
    "todos_url": "https://3.basecampapi.com/9999999/buckets/1234567/todolists/444444/todos.json"
  }
]
```

### List To-dos
`GET /buckets/{PROJECT_ID}/todolists/{TODOLIST_ID}/todos.json`

**Query parameters:**
- `status` — `active` (default) or `completed`

**Response:**
```json
[
  {
    "id": 555555,
    "title": "Design the homepage",
    "content": "<p>Create mockups for the new homepage</p>",
    "completed": false,
    "due_on": "2024-02-28",
    "assignees": [
      { "id": 12345, "name": "John Doe" }
    ],
    "creator": { "id": 12345, "name": "John Doe" },
    "created_at": "2024-02-01T10:00:00Z",
    "comments_count": 3,
    "comments_url": "https://3.basecampapi.com/9999999/buckets/1234567/recordings/555555/comments.json"
  }
]
```

### Get To-do
`GET /buckets/{PROJECT_ID}/todos/{TODO_ID}.json`

### Create To-do
`POST /buckets/{PROJECT_ID}/todolists/{TODOLIST_ID}/todos.json`

**Request body (JSON):**
```json
{
  "content": "Implement login flow",
  "description": "<p>Build OAuth2 login with PKCE</p>",
  "due_on": "2024-03-15",
  "assignee_ids": [12345, 67890],
  "notify": true
}
```

### Update To-do
`PUT /buckets/{PROJECT_ID}/todos/{TODO_ID}.json`

**Request body (JSON):**
```json
{
  "content": "Updated title",
  "due_on": "2024-03-20",
  "assignee_ids": [12345]
}
```

### Complete To-do
`POST /buckets/{PROJECT_ID}/todos/{TODO_ID}/completion.json`

### Uncomplete To-do
`DELETE /buckets/{PROJECT_ID}/todos/{TODO_ID}/completion.json`

### List Messages
`GET /buckets/{PROJECT_ID}/message_boards/{BOARD_ID}/messages.json`

### Post Message
`POST /buckets/{PROJECT_ID}/message_boards/{BOARD_ID}/messages.json`

**Request body (JSON):**
```json
{
  "subject": "Weekly Update",
  "content": "<p>Here's what happened this week...</p>",
  "category_id": 123456
}
```

### List Comments
`GET /buckets/{PROJECT_ID}/recordings/{RECORDING_ID}/comments.json`

### Add Comment
`POST /buckets/{PROJECT_ID}/recordings/{RECORDING_ID}/comments.json`

**Request body (JSON):**
```json
{
  "content": "<p>Great work on this! Let's move forward.</p>"
}
```

### List People
`GET /people.json`

### Get Person
`GET /people/{PERSON_ID}.json`

## Common Patterns

### Pagination
Link-header based. The `Link` response header contains the URL for the next page with `rel="next"`. No page or offset parameters. When no `Link` header, all results have been returned.

### Recordings
Many resources (to-dos, messages, documents) are "recordings" that share common features like comments. Use the `recordings/{RECORDING_ID}/comments.json` pattern for any commentable resource.

### Dock (Toolsets)
Each project has a `dock` array listing available tools (message_board, todoset, schedule, vault, etc.) with their IDs and URLs. Always get the project first to find tool IDs.

### Error Format
```json
{
  "status": 404,
  "error": "Not Found"
}
```

### Rate Limits
50 requests per 10 seconds. Returns 429 with `Retry-After` header. Include a descriptive `User-Agent` header.

## Important Notes
- **Account ID required** — Fetch `GET https://launchpad.37signals.com/authorization.json` first to get the `ACCOUNT_ID`.
- **JSON suffix** — All endpoints require `.json` suffix (e.g. `/projects.json`, not `/projects`).
- **HTML content** — All rich content uses HTML, not Markdown. Use `<p>`, `<strong>`, `<em>`, etc.
- **User-Agent required** — Basecamp requires a descriptive User-Agent header: `User-Agent: MyApp (email@example.com)`.
- **No scopes** — Basecamp doesn't use OAuth scopes. Access is all-or-nothing.
- **Token refresh** — Access tokens expire after 2 weeks. Automatic refresh via the runtime.
- **No DELETE for projects** — Projects can be trashed but not permanently deleted via API.
