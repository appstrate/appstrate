export const executionsPaths = {
  "/api/flows/{scope}/{name}/run": {
    post: {
      operationId: "runFlow",
      tags: ["Executions"],
      summary: "Execute a flow",
      description:
        "Start a flow execution (fire-and-forget). Returns the execution ID. Rate-limited to 20/min. Supports JSON body or multipart/form-data with file uploads.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        {
          name: "profileId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Connection profile ID to use for this execution. Overrides the user's default or flow-specific profile.",
        },
        {
          name: "version",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Version query to execute (exact version, dist-tag, or semver range). When provided, the execution uses the versioned manifest and prompt instead of the live flow.",
        },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                input: { type: "object", description: "Execution input values" },
                modelId: {
                  type: "string",
                  description:
                    "Model ID override for this execution. Takes priority over flow and org defaults.",
                },
                proxyId: {
                  type: "string",
                  description:
                    'Proxy ID override for this execution, or "none" to disable proxying. Takes priority over flow and org defaults.',
                },
              },
            },
          },
          "multipart/form-data": {
            schema: {
              type: "object",
              properties: {
                input: { type: "string", description: "JSON-encoded input values" },
                file: { type: "string", format: "binary", description: "File upload" },
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
        "400": {
          description:
            "Flow readiness validation failed (empty prompt, missing skill/tool, provider not connected, or incomplete config)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/FlowReadinessError" },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/flows/{scope}/{name}/executions": {
    get: {
      operationId: "listFlowExecutions",
      tags: ["Executions"],
      summary: "List executions for a flow",
      description: "List executions for a specific flow (org-scoped, default limit 50).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
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
                type: "array",
                items: { $ref: "#/components/schemas/Execution" },
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
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
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
        "409": { description: "Running executions exist" },
      },
    },
  },
  "/api/executions/{id}": {
    get: {
      operationId: "getExecution",
      tags: ["Executions"],
      summary: "Get execution status/result",
      description: "Get execution details including status, result, input, and duration.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
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
  "/api/executions/{id}/logs": {
    get: {
      operationId: "getExecutionLogs",
      tags: ["Executions"],
      summary: "Get execution logs",
      description: "Get persisted log entries for an execution.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Log entries",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/ExecutionLog" },
              },
            },
          },
        },
      },
    },
  },
  "/api/executions/{id}/cancel": {
    post: {
      operationId: "cancelExecution",
      tags: ["Executions"],
      summary: "Cancel an execution",
      description: "Cancel a running or pending execution.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Execution cancelled",
          content: {
            "application/json": {
              schema: { type: "object", properties: { ok: { type: "boolean" } } },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Execution not cancellable (already completed/failed)" },
      },
    },
  },
} as const;
