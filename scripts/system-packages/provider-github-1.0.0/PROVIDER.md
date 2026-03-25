# GitHub API

Base URL: `https://api.github.com`

## Quick Reference

GitHub REST API v3. Manage repositories, issues, pull requests, and users. All responses are JSON.
Always include `Accept: application/vnd.github+json` header.

## Key Endpoints

### Get Authenticated User
GET /user
Returns the authenticated user's profile.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: github" \
  -H "X-Target: https://api.github.com/user" \
  -H "Authorization: Bearer {{token}}" \
  -H "Accept: application/vnd.github+json"
```

### List Repositories
GET /user/repos
List repositories for the authenticated user.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: github" \
  -H "X-Target: https://api.github.com/user/repos?sort=updated&per_page=10" \
  -H "Authorization: Bearer {{token}}" \
  -H "Accept: application/vnd.github+json"
```

### List Issues
GET /repos/{owner}/{repo}/issues
List issues for a repository. Also returns pull requests (filter with `pull_request` field).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: github" \
  -H "X-Target: https://api.github.com/repos/{OWNER}/{REPO}/issues?state=open&per_page=10" \
  -H "Authorization: Bearer {{token}}" \
  -H "Accept: application/vnd.github+json"
```

### Create Issue
POST /repos/{owner}/{repo}/issues
Create a new issue.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: github" \
  -H "X-Target: https://api.github.com/repos/{OWNER}/{REPO}/issues" \
  -H "Authorization: Bearer {{token}}" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -d '{"title": "Bug report", "body": "Description here", "labels": ["bug"]}'
```

### List Pull Requests
GET /repos/{owner}/{repo}/pulls
List pull requests for a repository.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: github" \
  -H "X-Target: https://api.github.com/repos/{OWNER}/{REPO}/pulls?state=open&per_page=10" \
  -H "Authorization: Bearer {{token}}" \
  -H "Accept: application/vnd.github+json"
```

### Get Repository Content
GET /repos/{owner}/{repo}/contents/{path}
Get file or directory contents. File content is base64-encoded.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: github" \
  -H "X-Target: https://api.github.com/repos/{OWNER}/{REPO}/contents/README.md" \
  -H "Authorization: Bearer {{token}}" \
  -H "Accept: application/vnd.github+json"
```

### Create or Update File
PUT /repos/{owner}/{repo}/contents/{path}
Create or update a file. Requires base64-encoded content and SHA of existing file (for updates).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X PUT \
  -H "X-Provider: github" \
  -H "X-Target: https://api.github.com/repos/{OWNER}/{REPO}/contents/path/to/file.txt" \
  -H "Authorization: Bearer {{token}}" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -d '{"message": "Create file", "content": "SGVsbG8gV29ybGQ=", "branch": "main"}'
```

### Search Code
GET /search/code
Search for code across repositories.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: github" \
  -H "X-Target: https://api.github.com/search/code?q=filename:package.json+org:{ORG}" \
  -H "Authorization: Bearer {{token}}" \
  -H "Accept: application/vnd.github+json"
```

## Common Patterns

### Pagination
GitHub uses Link headers for pagination. Query params:
- `per_page` (max 100, default 30)
- `page` (1-based)

Response includes `Link` header with `rel="next"` and `rel="last"`.

### Rate Limits
- Authenticated: 5,000 requests/hour
- Search: 30 requests/minute
- Check with: `X-RateLimit-Remaining` response header

### Common Query Parameters
- `sort`: `created`, `updated`, `pushed`, `full_name`
- `direction`: `asc`, `desc`
- `state`: `open`, `closed`, `all`
- `since`: ISO 8601 timestamp for filtering updates

## Important Notes

- Always include `Accept: application/vnd.github+json` header.
- File content in responses is base64-encoded -- decode before use.
- The Issues API also returns PRs. Filter with: items lacking `pull_request` key are pure issues.
- For large repositories, use the Git Trees API instead of Contents API for recursive listing.
- `per_page` max is 100. Use pagination for larger result sets.