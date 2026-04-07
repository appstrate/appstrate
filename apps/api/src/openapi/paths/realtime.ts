// SPDX-License-Identifier: Apache-2.0

export const realtimePaths = {
  "/api/realtime/runs": {
    get: {
      operationId: "streamAllRuns",
      tags: ["Realtime"],
      summary: "SSE: all run status changes",
      description:
        'Server-Sent Events stream for all run status changes in the org. Supports cookie auth and API key auth via ?token=ask_... query parameter.\n\nEvent format: `event: run.status\\ndata: {"id":"run_...","status":"running","packageId":"@scope/name",...}\\n\\n`\n\nEvent types: `run.status` (status change), `run.log` (log entry, single-run stream only). Heartbeat `:ping` every 30s.',
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
      },
    },
  },
  "/api/realtime/runs/{id}": {
    get: {
      operationId: "streamRun",
      tags: ["Realtime"],
      summary: "SSE: single run events",
      description:
        "Server-Sent Events stream for run status + log events. Supports cookie auth and API key auth via ?token=ask_... query parameter.",
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
      },
    },
  },
  "/api/realtime/agents/{packageId}/runs": {
    get: {
      operationId: "streamAgentRuns",
      tags: ["Realtime"],
      summary: "SSE: agent run changes",
      description:
        "Server-Sent Events stream for run changes for a specific agent. Supports cookie auth and API key auth via ?token=ask_... query parameter.",
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
      },
    },
  },
} as const;
