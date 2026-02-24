# Reference

## Error Handling

### Error Response Format

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description"
}
```

### Common Error Codes

| Code                       | HTTP | Meaning                                     |
| -------------------------- | ---- | ------------------------------------------- |
| `FLOW_NOT_FOUND`           | 404  | Flow ID does not exist                      |
| `VALIDATION_ERROR`         | 400  | Input/config validation failed              |
| `DEPENDENCY_NOT_SATISFIED` | 400  | Required service not connected              |
| `CONFIG_INCOMPLETE`        | 400  | Required config fields missing              |
| `EXECUTION_IN_PROGRESS`    | 409  | Concurrent execution limit reached          |
| `UNAUTHORIZED`             | 401  | Missing or invalid authentication           |
| `FORBIDDEN`                | 403  | Insufficient permissions (not admin)        |
| `NAME_COLLISION`           | 400  | Flow/skill/extension ID already exists      |
| `MISSING_MANIFEST`         | 400  | ZIP import missing manifest.json            |
| `INVALID_MANIFEST`         | 400  | Manifest validation failed                  |
| `ZIP_INVALID`              | 400  | Corrupted or unreadable ZIP                 |
| `FILE_TOO_LARGE`           | 400  | Uploaded file exceeds size limit            |
| `MISSING_PROMPT`           | 400  | Flow missing prompt.md                      |
| `OPERATION_NOT_ALLOWED`    | 403  | Cannot modify built-in resource             |
| `FLOW_IN_USE`              | 409  | Cannot delete, resource referenced by flows |
| `RATE_LIMITED`             | 429  | Too many requests                           |

### Autonomous Error Recovery

When you get an error, **don't ask the user what to do**. Diagnose and resolve it yourself when possible:

| Error | Agent Action |
|-------|-------------|
| `DEPENDENCY_NOT_SATISFIED` | Call `GET /api/flows/{flowId}` → find which service has `status: "disconnected"` → call `GET /auth/integrations` to check the provider's `authMode` → if `api_key` or `custom`, ask user for credentials and connect. If `oauth2`, generate the auth URL and give it to the user. |
| `CONFIG_INCOMPLETE` | Call `GET /api/flows/{flowId}` → read `manifest.config.schema` to find required fields → check which are missing in `config` → if fields have `default` values, set them via `PUT /api/flows/{flowId}/config`. If no defaults, ask the user for values. |
| `NAME_COLLISION` | The resource already exists. Call `GET /api/flows` (or skills/extensions) to find it, then decide: update instead of create, or choose a different ID. |
| `EXECUTION_IN_PROGRESS` | Call `GET /api/flows/{flowId}/executions?limit=5` → find the running execution → either poll it until completion, or cancel via `POST /api/executions/{execId}/cancel`. |
| `FLOW_IN_USE` | Call `GET /api/library/skills/{id}` or `GET /api/library/extensions/{id}` → read the `flows` field → unlink from those flows first. |
| `UNAUTHORIZED` | Validate the API key with `GET /api/flows`. If it fails, tell the user their key is invalid/expired and ask for a new one. |

---

## Common Workflows

### Workflow 1: Set up a new external service integration

```
1. GET /api/providers                         → Check if the provider already exists
2. IF not found:
   POST /api/providers                        → Create it (ask user only for auth details: clientId/secret for OAuth2, or credential schema for custom)
3. GET /auth/integrations                     → Check if already connected
4. IF not connected:
   - authMode "api_key" → Ask user for the external API key → POST /auth/connect/{providerId}/api-key
   - authMode "custom"  → Read credentialSchema from provider → Ask user for values → POST /auth/connect/{providerId}/credentials
   - authMode "oauth2"  → POST /auth/connect/{providerId} → Give authUrl to user → Wait → Verify via GET /auth/integrations
5. GET /auth/integrations                     → Confirm status is "connected"
```

### Workflow 2: Create and run a flow from scratch

```
1. GET /api/flows                             → Check if the flow ID already exists
2. GET /api/providers                         → Check which providers are available for services
3. GET /api/library/skills                    → Check available skills
4. GET /api/library/extensions                → Check available extensions
5. POST /api/flows                            → Create the flow (manifest + prompt + skillIds + extensionIds)
6. GET /api/flows/{flowId}                    → Verify creation, check service status
7. IF services disconnected:
   → Follow Workflow 1 for each missing service
8. IF config has required fields:
   PUT /api/flows/{flowId}/config             → Set config values
9. POST /api/flows/{flowId}/run               → Run with input
10. Poll: GET /api/executions/{executionId}   → Until status is terminal
11. GET /api/executions/{executionId}/logs     → Get full execution log
```

### Workflow 3: Monitor an execution to completion

```
1. POST /api/flows/{flowId}/run → { executionId }
2. Loop:
   GET /api/executions/{executionId}
   - If status is "pending" or "running": wait 2-5 seconds, retry
   - If status is "success": read result field
   - If status is "failed": read error field + GET /api/executions/{executionId}/logs for details
   - If status is "timeout" or "cancelled": handle accordingly
3. GET /api/executions/{executionId}/logs → full execution log
```

### Workflow 4: Schedule a recurring flow

```
1. GET /api/flows/{flowId}                    → Verify flow exists and is fully configured
2. GET /api/flows/{flowId}/schedules          → Check if a schedule already exists
3. IF no schedule exists:
   POST /api/flows/{flowId}/schedules         → Create with cron expression
4. GET /api/schedules                         → Verify creation and next run time
```

### Workflow 5: Update an existing flow

```
1. GET /api/flows/{flowId}                    → Get current manifest, prompt, updatedAt, skills, extensions
2. PUT /api/flows/{flowId}                    → Update with new manifest/prompt + the updatedAt value
3. GET /api/flows/{flowId}                    → Verify the update was applied
```

---

## Health Check

```
GET /health
```

No auth required. Returns:

```json
{
  "status": "healthy",
  "uptime_ms": 123456,
  "checks": {
    "database": "ok",
    "flows": "ok"
  }
}
```

Status is `degraded` if any check fails.

---

## Rate Limits

| Endpoint                  | Limit                    |
| ------------------------- | ------------------------ |
| `POST /api/flows/:id/run` | 20 requests/min per user |
| `POST /api/flows/import`  | 10 requests/min per user |
| `POST /api/flows`         | 10 requests/min per user |

When rate-limited, the API returns HTTP 429 with `RATE_LIMITED` error code. Wait 60 seconds before retrying.
