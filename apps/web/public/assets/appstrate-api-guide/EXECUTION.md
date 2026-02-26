# Flow Execution & Monitoring

## Pre-flight Check (Mandatory)

**Before running any flow, always call `GET /api/flows/{flowId}` and verify:**

1. **Services**: Every entry in `services[]` must have `status: "connected"`. If any is `disconnected` or `expired`, resolve it before running.
2. **Admin bindings**: For services with `connectionMode: "admin"`, check `adminConnection` is set. If not, bind via `POST /api/flows/{flowId}/services/{serviceId}/bind`.
3. **Config**: Compare `config` (current values) against `manifest.config.schema` — ensure all `required` fields have values. If not, set them via `PUT /api/flows/{flowId}/config`.
4. **Running executions**: Check `runningExecutions` — if > 0, either wait or cancel the existing one.
5. **Input schema**: Read `manifest.input.schema` to know what input fields are required and their types.

Only ask the user for information that's not in the API response (e.g., what input values to use for this run).

## Run a Flow

```
POST /api/flows/{flowId}/run
Authorization: Bearer ask_...
Content-Type: application/json

{ "input": { "query": "Hello world", "limit": 5 } }
```

For flows with file inputs, use `multipart/form-data`:

```
POST /api/flows/{flowId}/run
Authorization: Bearer ask_...
Content-Type: multipart/form-data

input: {"language": "french"}
document: <file binary>
```

Returns `{ "executionId": "exec-abc123" }`. The execution runs asynchronously in a Docker container. Rate-limited to 20/min.

## Get Execution Status

```
GET /api/executions/{executionId}
Authorization: Bearer ask_...
```

Response:

```json
{
  "id": "exec-abc123",
  "flowId": "my-flow",
  "status": "running",
  "input": { "query": "Hello" },
  "result": null,
  "state": null,
  "error": null,
  "tokensUsed": 1500,
  "tokenUsage": { "inputTokens": 500, "outputTokens": 1000 },
  "startedAt": "2026-01-15T10:00:00Z",
  "completedAt": null,
  "duration": null
}
```

Status values: `pending`, `running`, `success`, `failed`, `timeout`, `cancelled`.

## Get Execution Logs

```
GET /api/executions/{executionId}/logs
Authorization: Bearer ask_...
```

Optional pagination: `?after={lastLogId}` for incremental fetching.

Returns array of log entries:

```json
[
  {
    "id": 1,
    "type": "system",
    "event": "execution_started",
    "message": "Execution started",
    "data": { "executionId": "exec-abc123" },
    "createdAt": "2026-01-15T10:00:00Z"
  },
  {
    "id": 2,
    "type": "agent",
    "event": "progress",
    "message": "Processing query...",
    "data": null,
    "createdAt": "2026-01-15T10:00:01Z"
  }
]
```

Log types: `system`, `agent`, `error`, `result`.

## Stream Execution (SSE)

```
GET /api/executions/{executionId}/stream
Authorization: Cookie-based only (not API key)
```

Server-Sent Events stream. First replays all existing logs from DB, then streams live updates.

SSE event types:

- `execution_started`: `{ executionId, startedAt }`
- `dependency_check`: `{ services: { gmail: "ok" } }`
- `adapter_started`: `{ adapter: "pi" }`
- `progress`: `{ message: "..." }` (repeated during execution)
- `result`: `{ summary: "...", ... }` (the flow output)
- `execution_completed`: `{ executionId, status: "success"|"failed"|"timeout" }`

## Cancel Execution

```
POST /api/executions/{executionId}/cancel
Authorization: Bearer ask_...
```

## List Flow Executions

```
GET /api/flows/{flowId}/executions?limit=50
Authorization: Bearer ask_...
```

## Delete Flow Executions

```
DELETE /api/flows/{flowId}/executions
Authorization: Bearer ask_...
```

Deletes all completed executions for the flow. Returns `{ "deleted": 15 }`.

## Execution Lifecycle

1. `POST /api/flows/{flowId}/run` validates input, checks service dependencies, creates execution record (status: `pending`)
2. Execution runs in background: creates isolated Docker network, starts sidecar proxy + agent container
3. Agent container receives the enriched prompt (raw prompt.md + structured context sections)
4. Agent calls external services via the sidecar proxy at `$SIDECAR_URL/proxy` with `X-Service` and `X-Target` headers
5. Agent streams progress events on stdout as JSON lines
6. On completion, result is validated against `output.schema` (if defined). If invalid, retries up to `outputRetries` times
7. Final result and status are persisted. If `result.state` exists, it's saved for the next execution

## State Persistence

Flows can maintain state across executions. If the agent's result includes a `state` field, it's persisted and injected into the next run as `## Previous State` in the prompt context. The agent can also query historical executions via the sidecar's `/execution-history` endpoint.

---

## Realtime Monitoring (SSE)

For browser-based monitoring, Appstrate provides SSE endpoints powered by PostgreSQL LISTEN/NOTIFY:

```
GET /api/realtime/executions              # All execution status changes
GET /api/realtime/executions/{executionId} # Single execution status + logs
GET /api/realtime/flows/{flowId}/executions # Execution changes for a flow
```

These are cookie-auth only (no API key support). Use `EventSource` in the browser or similar SSE client.

---

## Flow Automation & Triggering

Flows can be triggered in three ways. **When the user has a recurring or event-driven need, proactively suggest the appropriate triggering method.**

### 1. Manual / On-Demand

The user (or the agent) calls `POST /api/flows/{flowId}/run` directly. This is the default for one-off tasks.

### 2. API Trigger (Webhook Pattern)

Any external platform can trigger a flow by calling the Appstrate API with an API key. This is the **webhook pattern** — ideal when a flow should run in reaction to a specific event from another system.

```
POST {BASE_URL}/api/flows/{flowId}/run
Authorization: Bearer ask_...
Content-Type: application/json

{ "input": { "event": "new_ticket", "ticketId": "T-1234" } }
```

**Use cases:**
- A CRM creates a new lead → triggers a flow to enrich the data
- A form submission on Typeform/Tally → triggers a processing flow
- A GitHub push event → triggers a code review flow
- A Zapier/Make/n8n scenario routes an event → triggers an Appstrate flow

**How to set this up:**
1. Create an API key in Organization Settings (or via `POST /api/api-keys`)
2. Note the flow ID and the expected input schema (`GET /api/flows/{flowId}` → `manifest.input.schema`)
3. On the external platform, configure a webhook/HTTP action that calls `POST {BASE_URL}/api/flows/{flowId}/run` with the API key in `Authorization: Bearer ask_...` and the input payload in the request body
4. The external platform triggers the HTTP call on the desired event

**Tell the user:**

> Your flow can be triggered automatically from any platform that supports webhooks or HTTP requests. You need to configure a webhook on the external platform (e.g., Zapier, Make, n8n, or the service itself) that calls:
>
> ```
> POST {BASE_URL}/api/flows/{flowId}/run
> Authorization: Bearer ask_<your-api-key>
> Content-Type: application/json
> Body: { "input": { ... } }
> ```
>
> You can create an API key in Organization Settings > API Keys.

### 3. Cron Scheduling (Recurring)

For flows that need to run at regular intervals (every hour, every day at 9am, every Monday, etc.), Appstrate has a built-in scheduling system.

**Use cases:**
- Daily report generation at 9:00 AM
- Hourly inbox scanning
- Weekly digest every Monday morning
- Monthly data export on the 1st

The agent can create schedules via `POST /api/flows/{flowId}/schedules` (see `SCHEDULING.md`).

### Decision Guide: When to Recommend What

When the user describes a recurring or automated need, **proactively recommend the right approach**:

| User Need | Recommended Approach | Why |
|-----------|---------------------|-----|
| "Run this every day at 9am" | **Cron schedule** | Fixed time interval → cron is the right tool |
| "Run this every hour" | **Cron schedule** | Regular interval → cron |
| "Run this when I receive an email" | **Webhook (API trigger)** | Event-driven → needs external platform to detect the event and call the API |
| "Run this when a new ticket is created in Jira" | **Webhook (API trigger)** | Event-driven from external system |
| "Run this when someone submits a form" | **Webhook (API trigger)** | Event-driven from form platform |
| "Run this once a week and also when X happens" | **Both** | Cron for the weekly run + webhook for the event-driven trigger |
| "Run this right now" | **Manual run** | One-off → just `POST /api/flows/{flowId}/run` |

**When recommending the webhook pattern, also explain:**
- Which external platform could detect the event (e.g., "You can use Zapier/Make to watch for new Jira tickets and trigger the flow")
- That they'll need an API key for the external platform to authenticate
- The exact endpoint and payload format to configure

**When recommending cron scheduling:**
- Help the user express their timing in cron format
- Create the schedule via the API directly
- Confirm the next run time
