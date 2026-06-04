// SPDX-License-Identifier: Apache-2.0

export const schedulesPaths = {
  "/api/schedules": {
    get: {
      operationId: "listSchedules",
      tags: ["Schedules"],
      summary: "List all schedules",
      description: "List all schedules across all agents for the organization.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      responses: {
        "200": {
          description: "Schedule list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/Schedule" },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/agents/{scope}/{name}/schedules": {
    get: {
      operationId: "listAgentSchedules",
      tags: ["Schedules"],
      summary: "List schedules for an agent",
      description: "List all cron schedules configured for a specific agent.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Schedule list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/Schedule" },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
    post: {
      operationId: "createSchedule",
      tags: ["Schedules"],
      summary: "Create a schedule",
      description: "Create a cron schedule for an agent.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["cron_expression"],
              properties: {
                name: { type: "string" },
                cron_expression: {
                  type: "string",
                  minLength: 1,
                  description: "Cron expression (e.g. '0 9 * * 1-5')",
                },
                timezone: { type: "string", default: "UTC" },
                input: { type: "object" },
                config_override: {
                  type: "object",
                  description:
                    "Per-schedule config delta. Deep-merged with the application's persisted `config` every time the schedule fires.",
                },
                model_id_override: {
                  type: "string",
                  description:
                    "Override the persisted model on every run triggered by this schedule.",
                },
                proxy_id_override: {
                  type: "string",
                  description:
                    "Override the persisted proxy on every run triggered by this schedule.",
                },
                version_override: {
                  type: "string",
                  description:
                    "Pin the agent version every run triggered by this schedule. Literal label or dist-tag.",
                },
                connection_overrides: {
                  type: "object",
                  description:
                    'Per-integration connection picks frozen on the schedule row (flat-connections mechanism #3). Shape: `{ "@scope/integration": "<connection_id>" }`. Loses to admin pins (#1), beats actor-fallback (#4). Stored on `package_schedules.connection_overrides` and replayed on every fire.',
                  additionalProperties: { type: "string" },
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Schedule created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Schedule" },
              example: {
                id: "sched_cm1abc456def789",
                packageId: "@acme/email-sorter",
                userId: "usr_r3t5w8y1z6",
                endUserId: null,
                orgId: "org_r3t5w8y1z6",
                applicationId: "app_r3t5w8y1z6",
                name: "Weekday morning sort",
                enabled: true,
                cron_expression: "0 9 * * 1-5",
                timezone: "Europe/Paris",
                input: { folder: "inbox", maxEmails: 50 },
                last_run_at: null,
                next_run_at: "2026-01-16T09:00:00Z",
                createdAt: "2026-01-15T10:30:00Z",
                updatedAt: "2026-01-15T10:30:00Z",
                actor_name: "Pierre",
                actor_type: "user",
              },
            },
          },
        },
        "400": {
          description:
            "Validation error. Possible causes: missing/invalid cron expression, invalid input, or agent has file inputs (cannot be scheduled).",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/schedules/{id}": {
    get: {
      operationId: "getSchedule",
      tags: ["Schedules"],
      summary: "Get a schedule",
      description: "Get a single schedule by ID.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Schedule details",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Schedule" },
              example: {
                id: "sched_cm1abc456def789",
                packageId: "@acme/email-sorter",
                userId: "usr_r3t5w8y1z6",
                endUserId: null,
                orgId: "org_r3t5w8y1z6",
                applicationId: "app_r3t5w8y1z6",
                name: "Weekday morning sort",
                enabled: true,
                cron_expression: "0 9 * * 1-5",
                timezone: "Europe/Paris",
                input: { folder: "inbox", maxEmails: 50 },
                last_run_at: "2026-01-15T09:00:00Z",
                next_run_at: "2026-01-16T09:00:00Z",
                createdAt: "2026-01-14T14:00:00Z",
                updatedAt: "2026-01-15T09:00:05Z",
                actor_name: "Pierre",
                actor_type: "user",
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateSchedule",
      tags: ["Schedules"],
      summary: "Update a schedule",
      description: "Update a cron schedule (expression, timezone, enabled state, or input).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                cron_expression: { type: "string" },
                timezone: { type: "string" },
                enabled: { type: "boolean" },
                input: { type: "object" },
                config_override: {
                  type: ["object", "null"],
                  description: "Per-schedule config delta. Pass `null` to clear the override.",
                },
                model_id_override: { type: ["string", "null"] },
                proxy_id_override: { type: ["string", "null"] },
                version_override: { type: ["string", "null"] },
                connection_overrides: {
                  type: ["object", "null"],
                  description:
                    "Per-integration connection picks frozen on the schedule. Pass `null` to clear.",
                  additionalProperties: { type: "string" },
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Schedule updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Schedule" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteSchedule",
      tags: ["Schedules"],
      summary: "Delete a schedule",
      description: "Permanently delete a cron schedule.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Schedule deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/schedules/{id}/runs": {
    get: {
      operationId: "listScheduleRuns",
      tags: ["Schedules"],
      summary: "List runs for a schedule",
      description: "List recent runs triggered by a specific schedule.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
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
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Run" },
                  },
                  total: { type: "integer" },
                  hasMore: { type: "boolean" },
                },
                required: ["object", "data", "total", "hasMore"],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
} as const;
