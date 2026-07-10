// SPDX-License-Identifier: Apache-2.0

/**
 * Shared documentation snippet for the SSE `id:` field. Each frame
 * carries an `id` of the form `${subId}:${monotonic}` where `subId` is
 * a fresh UUID-suffixed identifier per connection. Ids are GLOBALLY
 * unique across reconnects (the prefix changes), so client-side
 * deduplication on `id` is safe. Server-side replay on reconnect is
 * NOT implemented — `Last-Event-ID` is logged for observability and
 * the client lands on the live tail of events. The id format is stable
 * but opaque; clients should treat it as a deduplication key, not parse it.
 */
const SSE_ID_FIELD_DESCRIPTION =
  "Each SSE frame carries an `id:` field of the form `${subscriberId}:${monotonic}`. " +
  "Ids are globally unique across reconnects (each new EventSource gets a fresh subscriberId). " +
  "Client-side dedup on `id` is safe. Server-side replay via `Last-Event-ID` is NOT implemented — " +
  "reconnect lands on the live tail; missed events are not replayed.";

export const realtimePaths = {
  "/api/realtime/runs": {
    get: {
      operationId: "streamAllRuns",
      tags: ["Realtime"],
      summary: "SSE: all run status changes",
      description:
        'Server-Sent Events stream for all run status changes in the org. Supports cookie auth and API key auth via ?token=ask_... query parameter. API keys must carry the `runs:read` scope — a valid key without it is rejected with 403.\n\nEvent format: `event: run_update\\ndata: {"id":"run_...","status":"running","packageId":"@scope/name",...}\\n\\n`\n\nEvent types: `run_update` (status change), `run_log` (log entry), `run_metric` (running cumulative cost + token usage), `connection_update` (INSERT/UPDATE/DELETE on integration_connections, actor-scoped to the caller\'s own rows). Heartbeat: a named SSE `event: ping` frame (empty data) sent immediately on connect and every 30s thereafter.\n\n' +
        SSE_ID_FIELD_DESCRIPTION,
      parameters: [
        { $ref: "#/components/parameters/SseOrgId" },
        { $ref: "#/components/parameters/SseAppId" },
        { $ref: "#/components/parameters/SseToken" },
        { $ref: "#/components/parameters/Verbose" },
      ],
      responses: {
        "200": {
          description: "SSE stream",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/realtime/runs/{id}": {
    get: {
      operationId: "streamRun",
      tags: ["Realtime"],
      summary: "SSE: single run events",
      description:
        "Server-Sent Events stream for run status + log events. Supports cookie auth and API key auth via ?token=ask_... query parameter. API keys must carry the `runs:read` scope — a valid key without it is rejected with 403.\n\nEvent types: `run_update` (status change), `run_log` (log entry), `run_metric` (running cumulative cost + token usage), `connection_update` (INSERT/UPDATE/DELETE on integration_connections, actor-scoped to the caller's own rows). Heartbeat: a named SSE `event: ping` frame (empty data) sent immediately on connect and every 30s thereafter.\n\n" +
        SSE_ID_FIELD_DESCRIPTION,
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { $ref: "#/components/parameters/SseOrgId" },
        { $ref: "#/components/parameters/SseAppId" },
        { $ref: "#/components/parameters/SseToken" },
        { $ref: "#/components/parameters/Verbose" },
      ],
      responses: {
        "200": {
          description: "SSE stream",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/realtime/agents/{packageId}/runs": {
    get: {
      operationId: "streamAgentRuns",
      tags: ["Realtime"],
      summary: "SSE: agent run changes",
      description:
        "Server-Sent Events stream for run changes for a specific agent. Supports cookie auth and API key auth via ?token=ask_... query parameter. API keys must carry the `runs:read` scope — a valid key without it is rejected with 403.\n\nEvent types: `run_update` (status change), `run_log` (log entry), `run_metric` (running cumulative cost + token usage), `connection_update` (INSERT/UPDATE/DELETE on integration_connections, actor-scoped to the caller's own rows). Heartbeat: a named SSE `event: ping` frame (empty data) sent immediately on connect and every 30s thereafter.\n\n" +
        SSE_ID_FIELD_DESCRIPTION,
      parameters: [
        {
          name: "packageId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Agent package ID",
        },
        { $ref: "#/components/parameters/SseOrgId" },
        { $ref: "#/components/parameters/SseAppId" },
        { $ref: "#/components/parameters/SseToken" },
        { $ref: "#/components/parameters/Verbose" },
      ],
      responses: {
        "200": {
          description: "SSE stream",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
} as const;
