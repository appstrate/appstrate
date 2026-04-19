# Appstrate API — Conventions & Gotchas

**For the complete endpoint list, always use the live source:**

- **Swagger UI**: https://app.appstrate.com/api/docs
- **OpenAPI JSON**: `GET https://app.appstrate.com/api/openapi.json`

This file documents only the conventions, gotchas, and non-obvious behaviors that the Swagger doesn't make obvious.

## Auth

Every org-scoped request needs **both** headers:

```
Authorization: Bearer ask_...
X-Org-Id: <org-id>
```

SSE realtime endpoints accept API key via query param instead: `?token=ask_...`

## Scope prefix: `@` is mandatory

All `{scope}/{name}` paths require the `@` prefix:

- ✅ `@tractr/my-agent`
- ❌ `tractr/my-agent` → returns HTML instead of JSON (silent failure)

## Run lifecycle

Statuses: `pending` → `running` → `success` | `failed` | `timeout` | `cancelled`

Run body (JSON): `{ input?, modelId?, proxyId? }`
Run body (multipart): `{ input (JSON string), file }`
Version param: `?version=1.0.0` or `?version=latest`

## Package import

- `POST /api/packages/import` — upload .afps ZIP
- 409 `DRAFT_OVERWRITE` → add `?force=true` to overwrite draft
- Updates require `lockVersion` field (409 on conflict)
- GitHub import: `POST /api/packages/import-github`

## Schedules

Create body: `{ connectionProfileId*, cronExpression*, name?, timezone?, input? }`

Common cron: `0 9 * * 1-5` (weekdays 9am), `0 */6 * * *` (every 6h), `0 0 * * 1` (weekly Monday).

## Rate Limits

| Endpoint             | Limit  |
| -------------------- | ------ |
| Agent run            | 20/min |
| Package import       | 10/min |
| Package download     | 50/min |
| Model/proxy/key test | 5/min  |
| OpenRouter search    | 10/min |

## Error Format

RFC 7807: `{ type, title, status, detail }`

| Status | Meaning                                           |
| ------ | ------------------------------------------------- |
| 400    | Validation error                                  |
| 401    | Auth missing or invalid                           |
| 403    | Insufficient permissions (check API key scopes)   |
| 404    | Not found (or missing `@` prefix — check scope)   |
| 409    | Conflict: draft overwrite or lockVersion mismatch |
| 429    | Rate limit exceeded                               |

## Common pitfalls

1. **`result: {}` on success** — `@appstrate/output` not in `dependencies.tools`. Add it to manifest.
2. **403 after platform update** — API key missing new scopes. Create a fresh key in the UI.
3. **HTML response** — Missing `@` prefix on scope. Use `@scope/name`.
4. **Agent doesn't call output tool** — Tool not in manifest `dependencies.tools`. Re-import after fixing.
5. **SSE doesn't connect with API key** — Use `?token=ask_...` query param, not Authorization header.
