// SPDX-License-Identifier: Apache-2.0

export const notificationsPaths = {
  "/api/notifications/unread-count": {
    get: {
      operationId: "getUnreadNotificationCount",
      tags: ["Notifications"],
      summary: "Get unread notification count",
      description: "Returns the number of unread run notifications for the current user.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Unread count",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  count: { type: "integer", description: "Number of unread notifications" },
                },
                required: ["count"],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/notifications/unread-counts-by-agent": {
    get: {
      operationId: "getUnreadCountsByAgent",
      tags: ["Notifications"],
      summary: "Get unread notification counts grouped by agent",
      description: "Returns the number of unread run notifications per agent for the current user.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Unread counts keyed by package ID",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  counts: {
                    type: "object",
                    additionalProperties: { type: "integer" },
                    description: "Map of packageId to unread notification count",
                  },
                },
                required: ["counts"],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/notifications/read/{runId}": {
    put: {
      operationId: "markNotificationRead",
      tags: ["Notifications"],
      summary: "Mark a notification as read",
      description: "Marks the notification for a specific run as read.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "runId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Mark result",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                },
                required: ["ok"],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/notifications/read-all": {
    put: {
      operationId: "markAllNotificationsRead",
      tags: ["Notifications"],
      summary: "Mark all notifications as read",
      description: "Marks all unread notifications as read for the current user.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Update result",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  updated: {
                    type: "integer",
                    description: "Number of notifications marked as read",
                  },
                },
                required: ["updated"],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/runs": {
    get: {
      operationId: "listRuns",
      tags: ["Notifications"],
      summary: "List runs",
      description:
        "Lists all runs for the organization across all agents, ordered by most recent. Use `?user=me` to filter to the current user's runs only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "user",
          in: "query",
          schema: { type: "string", enum: ["me"] },
          description:
            "Filter runs by user. `me` returns only the current user's runs. Omit for all org runs.",
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", default: 20, maximum: 100 },
          description: "Maximum number of runs to return",
        },
        {
          name: "offset",
          in: "query",
          schema: { type: "integer", default: 0 },
          description: "Number of runs to skip",
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
                  total: { type: "integer", description: "Total number of runs" },
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
};
