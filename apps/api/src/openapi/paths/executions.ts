export const executionsPaths = {
  "/api/flows/{flowId}/run": {
    post: {
      operationId: "runFlow",
      tags: ["Executions"],
      summary: "Execute a flow",
      description:
        "Start a flow execution (fire-and-forget). Returns the execution ID. Rate-limited to 20/min. Supports JSON body or multipart/form-data with file uploads.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                input: { type: "object", description: "Execution input values" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Execution started",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  executionId: { type: "string" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/flows/{flowId}/executions": {
    get: {
      operationId: "listFlowExecutions",
      tags: ["Executions"],
      summary: "List executions for a flow",
      description: "List executions for a specific flow (org-scoped, default limit 50).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", default: 50 },
        },
      ],
      responses: {
        "200": {
          description: "Execution list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  executions: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Execution" },
                  },
                },
              },
            },
          },
        },
      },
    },
    delete: {
      operationId: "deleteFlowExecutions",
      tags: ["Executions"],
      summary: "Delete all executions for a flow",
      description: "Delete all completed executions for a flow. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Executions deleted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { deleted: { type: "integer" } },
              },
            },
          },
        },
      },
    },
  },
  "/api/executions/{executionId}": {
    get: {
      operationId: "getExecution",
      tags: ["Executions"],
      summary: "Get execution status/result",
      description: "Get execution details including status, result, input, and duration.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "executionId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Execution detail",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Execution" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/executions/{executionId}/logs": {
    get: {
      operationId: "getExecutionLogs",
      tags: ["Executions"],
      summary: "Get execution logs",
      description:
        "Get persisted log entries for an execution. Supports pagination via `after` query param.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "executionId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "after",
          in: "query",
          description: "Cursor: return logs with ID greater than this value",
          schema: { type: "integer" },
        },
      ],
      responses: {
        "200": {
          description: "Log entries",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  logs: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ExecutionLog" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/executions/{executionId}/stream": {
    get: {
      operationId: "streamExecutionLogs",
      tags: ["Executions"],
      summary: "SSE execution log stream",
      description:
        "Server-Sent Events stream that replays all logs from the database, then streams live updates. Cookie auth only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "executionId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "SSE stream",
          content: {
            "text/event-stream": {
              schema: { type: "string" },
            },
          },
        },
      },
    },
  },
  "/api/executions/{executionId}/cancel": {
    post: {
      operationId: "cancelExecution",
      tags: ["Executions"],
      summary: "Cancel an execution",
      description: "Cancel a running or pending execution.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "executionId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": { description: "Execution cancelled" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
