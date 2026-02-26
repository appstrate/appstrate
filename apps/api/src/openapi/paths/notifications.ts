export const notificationsPaths = {
  "/api/notifications/unread-count": {
    get: {
      operationId: "getUnreadNotificationCount",
      tags: ["Notifications"],
      summary: "Get unread notification count",
      description: "Returns the number of unread execution notifications for the current user.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Unread count",
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
      },
    },
  },
  "/api/notifications/read/{executionId}": {
    put: {
      operationId: "markNotificationRead",
      tags: ["Notifications"],
      summary: "Mark a notification as read",
      description: "Marks the notification for a specific execution as read.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "executionId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Mark result",
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
      },
    },
  },
  "/api/executions": {
    get: {
      operationId: "listUserExecutions",
      tags: ["Notifications"],
      summary: "List all user executions",
      description:
        "Lists all executions for the current user across all flows, ordered by most recent.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", default: 20, maximum: 100 },
          description: "Maximum number of executions to return",
        },
        {
          name: "offset",
          in: "query",
          schema: { type: "integer", default: 0 },
          description: "Number of executions to skip",
        },
      ],
      responses: {
        "200": {
          description: "Paginated execution list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  executions: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Execution" },
                  },
                  total: { type: "integer", description: "Total number of executions" },
                },
                required: ["executions", "total"],
              },
            },
          },
        },
      },
    },
  },
};
