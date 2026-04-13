# Jira API

Base URL: `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3`

Project tracking and issue management platform by Atlassian. Uses the Jira Cloud REST API v3. Before making API calls, you must retrieve the `cloudId` by calling the accessible resources endpoint. All issue descriptions and comments use Atlassian Document Format (ADF), a structured JSON format.

## Endpoints

### Get Accessible Resources
`GET https://api.atlassian.com/oauth/token/accessible-resources`

Returns the list of Jira sites accessible with the current token. Use the `id` field as `cloudId` in all subsequent API calls.

**Response:**
```json
[
  {
    "id": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    "url": "https://mycompany.atlassian.net",
    "name": "My Company",
    "scopes": ["read:jira-work", "write:jira-work"],
    "avatarUrl": "https://site-admin-avatar-cdn.prod.public.atl-paas.net/..."
  }
]
```

### Get Myself
`GET /rest/api/3/myself`

Returns the currently authenticated user.

**Response:**
```json
{
  "accountId": "5b10ac8d82e05b22cc7d4ef5",
  "displayName": "John Doe",
  "emailAddress": "john@example.com",
  "active": true,
  "timeZone": "Europe/Paris"
}
```

### Search Issues (JQL)
`GET /rest/api/3/search`

Search for issues using JQL (Jira Query Language). Requires `read:jira-work` scope.

**Query parameters:**
- `jql` — JQL query string (e.g. `project = PROJ AND status = "In Progress"`)
- `startAt` — Pagination offset (default 0)
- `maxResults` — Max results per page (default 50, max 100)
- `fields` — Comma-separated field names to return (e.g. `summary,status,assignee`)

**Response:**
```json
{
  "startAt": 0,
  "maxResults": 50,
  "total": 245,
  "issues": [
    {
      "id": "10042",
      "key": "PROJ-123",
      "fields": {
        "summary": "Fix login page bug",
        "status": { "name": "In Progress", "id": "3" },
        "assignee": { "displayName": "John Doe", "accountId": "5b10ac8d..." },
        "priority": { "name": "High", "id": "2" },
        "issuetype": { "name": "Bug", "id": "1" },
        "created": "2024-01-15T09:30:00.000+0000",
        "updated": "2024-01-16T14:20:00.000+0000"
      }
    }
  ]
}
```

### Get Issue
`GET /rest/api/3/issue/{ISSUE_ID_OR_KEY}`

**Query parameters:**
- `fields` — Comma-separated field names
- `expand` — Additional info to include (e.g. `changelog,renderedFields`)

### Create Issue
`POST /rest/api/3/issue`

Requires `write:jira-work` scope.

**Request body (JSON):**
```json
{
  "fields": {
    "project": { "key": "PROJ" },
    "summary": "New feature request",
    "description": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [
            { "type": "text", "text": "Description of the feature." }
          ]
        }
      ]
    },
    "issuetype": { "name": "Task" },
    "assignee": { "accountId": "5b10ac8d82e05b22cc7d4ef5" },
    "priority": { "name": "Medium" }
  }
}
```

**Response:**
```json
{
  "id": "10043",
  "key": "PROJ-124",
  "self": "https://api.atlassian.com/ex/jira/.../rest/api/3/issue/10043"
}
```

### Update Issue
`PUT /rest/api/3/issue/{ISSUE_ID_OR_KEY}`

**Request body (JSON):**
```json
{
  "fields": {
    "summary": "Updated summary",
    "priority": { "name": "High" }
  }
}
```

### Transition Issue (Change Status)
`POST /rest/api/3/issue/{ISSUE_ID_OR_KEY}/transitions`

First, get available transitions, then execute one.

**Get transitions:** `GET /rest/api/3/issue/{ISSUE_ID_OR_KEY}/transitions`

**Execute transition:**
```json
{
  "transition": { "id": "31" }
}
```

### Delete Issue
`DELETE /rest/api/3/issue/{ISSUE_ID_OR_KEY}`

**Query parameters:**
- `deleteSubtasks` — Delete subtasks too (default false)

### List Issue Comments
`GET /rest/api/3/issue/{ISSUE_ID_OR_KEY}/comment`

**Query parameters:**
- `startAt` — Pagination offset
- `maxResults` — Max per page (default 50)

### Add Comment
`POST /rest/api/3/issue/{ISSUE_ID_OR_KEY}/comment`

**Request body (JSON):**
```json
{
  "body": {
    "type": "doc",
    "version": 1,
    "content": [
      {
        "type": "paragraph",
        "content": [
          { "type": "text", "text": "This is a comment." }
        ]
      }
    ]
  }
}
```

### Search Projects
`GET /rest/api/3/project/search`

**Query parameters:**
- `startAt` — Pagination offset
- `maxResults` — Max per page (default 50)
- `query` — Filter by name

### Get Project
`GET /rest/api/3/project/{PROJECT_ID_OR_KEY}`

### Search Users
`GET /rest/api/3/user/search`

**Query parameters:**
- `query` — Search string (name or email)
- `startAt`, `maxResults`

## Common Patterns

### Pagination
Offset-based: responses include `startAt`, `maxResults`, and `total`. Increment `startAt` by `maxResults` to get the next page. Stop when `startAt + maxResults >= total`.

### JQL (Jira Query Language)
Used in the search endpoint. Examples:
- `project = "PROJ"` — Issues in a project
- `status = "In Progress"` — By status
- `assignee = currentUser()` — Assigned to me
- `created >= -7d` — Created in last 7 days
- `project = PROJ AND status IN ("To Do", "In Progress") ORDER BY priority DESC`

### Atlassian Document Format (ADF)
Descriptions and comments use ADF (structured JSON), not plain text or Markdown. Basic structure:
```json
{
  "type": "doc",
  "version": 1,
  "content": [
    {
      "type": "paragraph",
      "content": [{ "type": "text", "text": "Hello world" }]
    }
  ]
}
```

### Error Format
```json
{
  "errorMessages": ["Issue does not exist or you do not have permission to see it."],
  "errors": {}
}
```

### Rate Limits
Rate limits vary. Typical: ~100 requests per minute. No standard rate limit headers. Returns 429 with `Retry-After` header when exceeded.

## Important Notes
- **Cloud ID required** — Before any API call, fetch `GET /oauth/token/accessible-resources` to get the `cloudId`. All API paths are prefixed with `/ex/jira/{cloudId}`.
- **ADF format** — Descriptions and comments must use Atlassian Document Format (JSON), not Markdown or HTML.
- **Token refresh** — Access tokens expire after 1 hour. Refresh tokens rotate on each use (90-day inactivity expiry).
- **Issue keys** — Use project key + number format (e.g. `PROJ-123`). Both key and numeric ID work in paths.
- **Transitions** — To change an issue's status, first GET available transitions, then POST the transition ID.
- **Agile API** — Boards and sprints use a separate base path: `/rest/agile/1.0/` (same `cloudId` prefix).
