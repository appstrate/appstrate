# Writing Effective prompt.md Files

## Table of Contents

- [Container Environment](#container-environment)
- [Auto-Injected Sections](#auto-injected-sections)
- [Sidecar Proxy Protocol](#sidecar-proxy-protocol)
- [Recommended Structure](#recommended-structure)
- [Memory](#memory-scopes)
- [Incremental Processing](#incremental-processing)
- [Common Mistakes](#common-mistakes)

## Container Environment

- **Runtimes**: Bun (primary) + Python3/pip
- **Working dir**: `/workspace`
- **Uploads**: `/workspace/documents/`
- **Ephemeral**: destroyed after execution. Persist via state, memory, output only.
- **Network**: direct outbound HTTP/HTTPS for public endpoints. Sidecar only for authenticated provider calls.

## Auto-Injected Sections

The platform prepends these automatically. Do NOT repeat them in prompt.md:

1. `## System` + `### Environment` — identity, container, timeout
2. `### Persistence` — state + memory
3. `### Tools` — `workspace_list/read/write/delete/move/mkdir/delete_folder` + attached tools
4. `### Skills` — references at `.pi/skills/`
5. `## Authenticated Provider API` — sidecar proxy with `X-Provider`
6. `## User Input` — input field values
7. `## Documents` — uploaded file paths
8. `## Configuration` — config values
9. `## Previous State` — JSON from last execution
10. `## Memory` — 3 scoped arrays
11. `## Execution History` — curl for history via sidecar
12. `## Output Format` — expected JSON + validation rules

## Sidecar Proxy Protocol

Authenticated API calls MUST go through the sidecar:

```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: @appstrate/gmail" \
  -H "X-Target: https://gmail.googleapis.com/gmail/v1/users/me/messages" \
  -H "Authorization: Bearer {{access_token}}"
```

### Headers

| Header              | Required | Description                                  |
| ------------------- | -------- | -------------------------------------------- |
| `X-Provider`        | Yes      | Scoped provider ID (`@scope/name`)           |
| `X-Target`          | Yes      | Full target URL                              |
| `X-Substitute-Body` | No       | `true` to replace `{{placeholders}}` in body |
| `X-Proxy`           | No       | Override proxy for this request              |

### Credential Placeholders

| Auth Mode | Placeholder        | Example                                  |
| --------- | ------------------ | ---------------------------------------- |
| OAuth2    | `{{access_token}}` | `Authorization: Bearer {{access_token}}` |
| API Key   | `{{apiKey}}`       | `X-Api-Key: {{apiKey}}`                  |
| Custom    | `{{fieldName}}`    | Any field from `credentialSchema`        |

### Response Behavior

- Forwarded as-is (status + body + Content-Type)
- > 50KB truncated (`X-Truncated: true`)
- Sidecar errors: `{ "error": "..." }` with 4xx/5xx

Public APIs (no auth): call directly, no sidecar needed.

## Recommended Structure

````markdown
# Objective

One clear sentence.

# Steps

1. **Fetch data**
   ```bash
   curl -s "$SIDECAR_URL/proxy" \
     -H "X-Provider: @appstrate/provider" \
     -H "X-Target: https://api.example.com/endpoint" \
     -H "Authorization: Bearer {{access_token}}"
   ```
````

2. **Process** — Transform, filter, summarize
3. **Return results** — JSON matching output schema

# Incremental Processing

How to use Previous State for delta processing.

# Rules

- Constraints and edge cases
- Error handling
- Output format

````

## Memory

| Scope | Purpose | Visibility |
|-------|---------|------------|
| Memories | API quirks, data patterns, learnings | Shared across all users of the agent |

Include memory instructions only when the agent should learn across runs. Be selective.

## Incremental Processing

For scheduled/recurring agents, use state to track progress:

```markdown
Check `## Previous State` for `lastSyncTimestamp`.

- **First run**: Process all items from last 7 days.
- **Subsequent runs**: Only items after `lastSyncTimestamp`.

Always return `state.lastSyncTimestamp` = current timestamp.
Process all pages before updating timestamp (timeout safety).
````

## Common Mistakes

| Mistake                                              | Fix                                               |
| ---------------------------------------------------- | ------------------------------------------------- |
| Repeating `## User Input` or `## Configuration`      | Platform injects these — just reference values    |
| `X-Service` instead of `X-Provider`                  | Use `X-Provider: @scope/name`                     |
| Missing `X-Target` header                            | Always include full URL                           |
| URL-based routing (`$SIDECAR_URL/proxy/https://...`) | Use header: `X-Target` for URL                    |
| No credential placeholder                            | Add `Authorization: Bearer {{access_token}}` etc. |
| Hardcoding URLs from config                          | Put in `config.schema`, reference from config     |
| `required: true` on properties                       | Use top-level `"required": ["field1"]` array      |
| No output format specified                           | Include clear JSON example                        |
| Writing prompt in wrong language                     | Match target audience language                    |
| JSON output not mandatory                            | Agent must always return valid JSON               |
