export const schedulesPaths = {
  "/api/schedules": {
    get: {
      operationId: "listSchedules",
      tags: ["Schedules"],
      summary: "List all schedules",
      description: "List all schedules across all flows for the organization.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Schedule list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  schedules: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Schedule" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/flows/{flowId}/schedules": {
    get: {
      operationId: "listFlowSchedules",
      tags: ["Schedules"],
      summary: "List schedules for a flow",
      description: "List all cron schedules configured for a specific flow.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Schedule list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  schedules: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Schedule" },
                  },
                },
              },
            },
          },
        },
      },
    },
    post: {
      operationId: "createSchedule",
      tags: ["Schedules"],
      summary: "Create a schedule",
      description: "Create a cron schedule for a flow.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["cronExpression"],
              properties: {
                name: { type: "string" },
                cronExpression: {
                  type: "string",
                  description: "Cron expression (e.g. '0 9 * * 1-5')",
                },
                timezone: { type: "string", default: "UTC" },
                enabled: { type: "boolean", default: true },
                input: { type: "object" },
              },
            },
          },
        },
      },
      responses: {
        "201": { description: "Schedule created" },
        "400": { $ref: "#/components/responses/ValidationError" },
      },
    },
  },
  "/api/schedules/{scheduleId}": {
    get: {
      operationId: "getSchedule",
      tags: ["Schedules"],
      summary: "Get a schedule",
      description: "Get details of a single cron schedule.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scheduleId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Schedule detail",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Schedule" },
            },
          },
        },
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
        { name: "scheduleId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
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
        "200": { description: "Schedule updated" },
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
        { name: "scheduleId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Schedule deleted" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
