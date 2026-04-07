// SPDX-License-Identifier: Apache-2.0

export const runsPaths = {
  "/api/agents/{scope}/{name}/run": {
    post: {
      operationId: "runAgent",
      tags: ["Runs"],
      summary: "Execute an agent",
      description:
        "Start an agent run (fire-and-forget). Returns the run ID. Rate-limited to 20/min. Supports JSON body or multipart/form-data with file uploads.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/AppstrateUser" },
        { $ref: "#/components/parameters/AppstrateVersion" },
        { $ref: "#/components/parameters/IdempotencyKey" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
        },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        {
          name: "version",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Version query to execute (exact version, dist-tag, or semver range). When provided, the run uses the versioned manifest and prompt instead of the live agent.",
        },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                input: { type: "object", description: "Run input values" },
                modelId: {
                  type: "string",
                  description:
                    "Model ID override for this run. Takes priority over agent and org defaults.",
                },
                proxyId: {
                  type: "string",
                  description:
                    'Proxy ID override for this run, or "none" to disable proxying. Takes priority over agent and org defaults.',
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
          description: "Run started",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
            Sunset: { $ref: "#/components/headers/Sunset" },
            RateLimit: { $ref: "#/components/headers/RateLimit" },
            "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  runId: { type: "string" },
                },
              },
              example: {
                runId: "run_cm1abc123def456",
              },
            },
          },
        },
        "400": {
          description:
            "Agent readiness validation failed (empty prompt, missing skill/tool, provider not connected, or incomplete config)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "402": {
          description: "Quota exceeded (Cloud only)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "409": { $ref: "#/components/responses/IdempotencyInProgress" },
        "422": { $ref: "#/components/responses/IdempotencyConflict" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/agents/{scope}/{name}/runs": {
    get: {
      operationId: "listAgentRuns",
      tags: ["Runs"],
      summary: "List runs for an agent",
      description: "List runs for a specific agent (org-scoped, default limit 50).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
        },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
        {
          name: "offset",
          in: "query",
          schema: { type: "integer", minimum: 0, default: 0 },
        },
      ],
      responses: {
        "200": {
          description: "Paginated run list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  runs: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Run" },
                  },
                  total: { type: "integer" },
                },
                required: ["runs", "total"],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
    delete: {
      operationId: "deleteAgentRuns",
      tags: ["Runs"],
      summary: "Delete all runs for an agent",
      description: "Delete all completed runs for an agent.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
        },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Runs deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { deleted: { type: "integer" } },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description: "Running runs exist",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Conflict",
                status: 409,
                detail: "Cannot delete runs while agent has active runs",
                code: "conflict",
                requestId: "req_abc123",
              },
            },
          },
        },
      },
    },
  },
  "/api/runs/{id}": {
    get: {
      operationId: "getRun",
      tags: ["Runs"],
      summary: "Get run status/result",
      description: "Get run details including status, result, input, and duration.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Run detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Run" },
              example: {
                id: "run_cm1abc123def456",
                packageId: "@acme/email-sorter",
                userId: "usr_k7x9m2p4q1",
                orgId: "org_r3t5w8y1z6",
                status: "success",
                input: { folder: "inbox", maxEmails: 50 },
                result: { processed: 42, labeled: 38 },
                state: { lastProcessedId: "msg_99f2a" },
                tokensUsed: 12450,
                tokenUsage: { input: 8200, output: 4250 },
                startedAt: "2026-01-15T10:30:00Z",
                completedAt: "2026-01-15T10:31:12Z",
                duration: 72000,
                connectionProfileId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                scheduleId: "sched_cm1abc456def789",
                versionLabel: "1.2.0",
                versionDirty: false,
                proxyLabel: null,
                modelLabel: "Claude Sonnet 4",
                modelSource: "system",
                cost: 0.0034,
                endUserId: null,
                applicationId: "app_m4n5o6p7",
                metadata: null,
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/runs/{id}/logs": {
    get: {
      operationId: "getRunLogs",
      tags: ["Runs"],
      summary: "Get run logs",
      description: "Get persisted log entries for a run.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Log entries",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/RunLog" },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/runs/{id}/cancel": {
    post: {
      operationId: "cancelRun",
      tags: ["Runs"],
      summary: "Cancel a run",
      description: "Cancel a running or pending run.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Run cancelled",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { type: "object", properties: { ok: { type: "boolean" } } },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Run not cancellable (already completed/failed)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Conflict",
                status: 409,
                detail: "Run has already completed and cannot be cancelled",
                code: "conflict",
                requestId: "req_def456",
              },
            },
          },
        },
      },
    },
  },
} as const;
