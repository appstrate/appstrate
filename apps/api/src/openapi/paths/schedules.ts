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
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
        },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["connectionProfileId", "cronExpression"],
              properties: {
                name: { type: "string" },
                connectionProfileId: {
                  type: "string",
                  format: "uuid",
                  description:
                    "Connection profile to use for provider credentials (user or app profile)",
                },
                cronExpression: {
                  type: "string",
                  description: "Cron expression (e.g. '0 9 * * 1-5')",
                },
                timezone: { type: "string", default: "UTC" },
                input: { type: "object" },
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
                connectionProfileId: { type: "string", format: "uuid" },
                name: { type: "string" },
                cronExpression: { type: "string" },
                timezone: { type: "string" },
                enabled: { type: "boolean" },
                input: { type: "object" },
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
  },
} as const;
