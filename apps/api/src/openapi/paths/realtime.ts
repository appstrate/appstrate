export const realtimePaths = {
  "/api/realtime/executions": {
    get: {
      operationId: "streamAllExecutions",
      tags: ["Realtime"],
      summary: "SSE: all execution status changes",
      description:
        "Server-Sent Events stream for all execution status changes in the org. Cookie auth only (no API key support).",
      security: [{ cookieAuth: [] }],
      parameters: [
        { $ref: "#/components/parameters/SseOrgId" },
        { $ref: "#/components/parameters/Verbose" },
      ],
      responses: {
        "200": {
          description: "SSE stream",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
      },
    },
  },
  "/api/realtime/executions/{executionId}": {
    get: {
      operationId: "streamExecution",
      tags: ["Realtime"],
      summary: "SSE: single execution events",
      description: "Server-Sent Events stream for execution status + log events. Cookie auth only.",
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: "executionId", in: "path", required: true, schema: { type: "string" } },
        { $ref: "#/components/parameters/SseOrgId" },
        { $ref: "#/components/parameters/Verbose" },
      ],
      responses: {
        "200": {
          description: "SSE stream",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
      },
    },
  },
  "/api/realtime/flows/{flowId}/executions": {
    get: {
      operationId: "streamFlowExecutions",
      tags: ["Realtime"],
      summary: "SSE: flow execution changes",
      description:
        "Server-Sent Events stream for execution changes for a specific flow. Cookie auth only.",
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
        { $ref: "#/components/parameters/SseOrgId" },
        { $ref: "#/components/parameters/Verbose" },
      ],
      responses: {
        "200": {
          description: "SSE stream",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
      },
    },
  },
} as const;
