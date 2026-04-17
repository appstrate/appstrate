// SPDX-License-Identifier: Apache-2.0

export const notificationsPaths = {
  "/api/notifications/unread-count": {
    get: {
      operationId: "getUnreadNotificationCount",
      tags: ["Notifications"],
      summary: "Get unread notification count",
      description: "Returns the number of unread run notifications for the current user.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
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
              example: { count: 5 },
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
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
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
              example: {
                counts: { "@acme/email-sorter": 3, "@appstrate/code-reviewer": 2 },
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
        { $ref: "#/components/parameters/XAppId" },
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
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
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
  // NOTE: GET /api/runs is documented in paths/runs.ts — the handler lives
  // under the notifications router for historical reasons (shared unread-
  // count query helpers), but the path belongs with the rest of the Runs
  // surface. Keep the OpenAPI definition there to avoid a duplicate-key
  // collision during spec assembly (object spread = last-wins, which would
  // silently shadow new query params added to paths/runs.ts).
};
