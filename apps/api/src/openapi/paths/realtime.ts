export const realtimePaths = {
  "/api/realtime/executions": {
    get: {
      operationId: "streamAllExecutions",
      tags: ["Realtime"],
      summary: "SSE: all execution status changes",
      description:
        "Server-Sent Events stream for all execution status changes in the org. Supports cookie auth and API key auth via ?token=ask_... query parameter.",
      parameters: [
        { $ref: "#/components/parameters/SseOrgId" },
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
  "/api/realtime/executions/{id}": {
    get: {
      operationId: "streamExecution",
      tags: ["Realtime"],
      summary: "SSE: single execution events",
      description:
        "Server-Sent Events stream for execution status + log events. Supports cookie auth and API key auth via ?token=ask_... query parameter.",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { $ref: "#/components/parameters/SseOrgId" },
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
  "/api/realtime/flows/{packageId}/executions": {
    get: {
      operationId: "streamFlowExecutions",
      tags: ["Realtime"],
      summary: "SSE: flow execution changes",
      description:
        "Server-Sent Events stream for execution changes for a specific flow. Supports cookie auth and API key auth via ?token=ask_... query parameter.",
      parameters: [
        {
          name: "packageId",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Flow package ID",
        },
        { $ref: "#/components/parameters/SseOrgId" },
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
