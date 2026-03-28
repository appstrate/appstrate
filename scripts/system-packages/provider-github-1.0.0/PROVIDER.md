# GitHub API

Base URL: `https://api.github.com`

GitHub REST API v3. Manage repositories, issues, pull requests, and users. All responses are JSON. Always include `Accept: application/vnd.github+json` header.

## Endpoints

### Get Authenticated User
`GET /user`

Returns the authenticated user's profile.

### List Repositories
`GET /user/repos`

List repositories for the authenticated user.

**Query parameters:**
- `sort` — `created`, `updated`, `pushed`, `full_name`
- `direction` — `asc`, `desc`
- `per_page` — results per page (max 100, default 30)
- `page` — page number (1-based)

### List Issues
`GET /repos/{OWNER}/{REPO}/issues`

List issues for a repository. Also returns pull requests (filter by checking for `pull_request` key).

**Query parameters:**
- `state` — `open`, `closed`, `all`
- `labels` — comma-separated label names
- `sort` — `created`, `updated`, `comments`
- `direction` — `asc`, `desc`
- `since` — ISO 8601 timestamp (only issues updated after this date)
- `per_page`, `page`

### Create Issue
`POST /repos/{OWNER}/{REPO}/issues`

**Request body:**
```json
{
  "title": "Bug report",
  "body": "Description here",
  "labels": ["bug"],
  "assignees": ["username"]
}
```

### Update Issue
`PATCH /repos/{OWNER}/{REPO}/issues/{ISSUE_NUMBER}`

**Request body:**
```json
{
  "title": "Updated title",
  "state": "closed",
  "labels": ["bug", "wontfix"]
}
```

### List Pull Requests
`GET /repos/{OWNER}/{REPO}/pulls`

**Query parameters:**
- `state` — `open`, `closed`, `all`
- `sort` — `created`, `updated`, `popularity`, `long-running`
- `direction` — `asc`, `desc`
- `per_page`, `page`

### Get Repository Content
`GET /repos/{OWNER}/{REPO}/contents/{PATH}`

Get file or directory contents. File content is base64-encoded in the response.

**Query parameters:**
- `ref` — Branch, tag, or commit SHA (defaults to default branch)

**Response (file):**
```json
{
  "name": "README.md",
  "path": "README.md",
  "sha": "abc123",
  "size": 1024,
  "type": "file",
  "content": "base64-encoded-content",
  "encoding": "base64"
}
```

### Create or Update File
`PUT /repos/{OWNER}/{REPO}/contents/{PATH}`

Requires base64-encoded content. For updates, include the `sha` of the existing file.

**Request body:**
```json
{
  "message": "Create file",
  "content": "SGVsbG8gV29ybGQ=",
  "branch": "main",
  "sha": "existing-file-sha (required for updates)"
}
```

### Search Code
`GET /search/code`

**Query parameters:**
- `q` — search query (e.g. `filename:package.json org:myorg`, `language:typescript path:src`)
- `sort` — Only valid value: `indexed` (sorts by last indexed time)
- `per_page`, `page`

### Search Repositories
`GET /search/repositories`

**Query parameters:**
- `q` — search query (e.g. `language:python stars:>100`)
- `sort` — `stars`, `forks`, `help-wanted-issues`, `updated`
- `per_page`, `page`

## Common Patterns

### Pagination
GitHub uses Link headers for pagination. Query params:
- `per_page` (max 100, default 30)
- `page` (1-based)

Response includes `Link` header with `rel="next"` and `rel="last"`.

### Date Format
ISO 8601: `2024-01-15T09:30:00Z`

## Rate Limits

- Authenticated: 5,000 requests/hour
- Search: 30 requests/minute
- Code search: 9 requests/minute (stricter than general search limit)
- Check remaining quota via `X-RateLimit-Remaining` response header

## Important Notes

- Always include `Accept: application/vnd.github+json` header.
- File content in responses is base64-encoded — decode before use.
- The Issues API also returns PRs. Items without a `pull_request` key are pure issues.
- For large repositories, use the Git Trees API instead of Contents API for recursive listing.
- `per_page` max is 100. Use pagination for larger result sets.
