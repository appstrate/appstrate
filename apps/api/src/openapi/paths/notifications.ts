// SPDX-License-Identifier: Apache-2.0

const notificationObject = {
  type: "object",
  required: ["id", "type", "run_id", "payload", "read_at", "created_at"],
  properties: {
    id: { type: "string", format: "uuid", description: "Notification id" },
    type: { type: "string", description: "Notification kind, e.g. run_completed" },
    run_id: {
      type: ["string", "null"],
      description: "Originating run id, when the notification references one",
    },
    payload: {
      type: ["object", "null"],
      additionalProperties: true,
      description: "Render-without-join data (agent_id, status)",
    },
    read_at: {
      type: ["string", "null"],
      format: "date-time",
      description: "When the recipient marked it read; null if unread",
    },
    created_at: { type: "string", format: "date-time" },
  },
} as const;

export const notificationsPaths = {
  "/api/notifications": {
    get: {
      operationId: "listNotifications",
      tags: ["Notifications"],
      summary: "List notifications",
      description:
        'Keyset-paginated list of the current recipient\'s notifications, newest first. Follow the `Link: rel="next"` header (`?startingAfter=<id>`) to page. `?unread=true` returns unread only.',
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "unread",
          in: "query",
          required: false,
          schema: { type: "boolean" },
          description: "When true, only unread notifications are returned",
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        {
          name: "startingAfter",
          in: "query",
          required: false,
          schema: { type: "string", format: "uuid" },
          description:
            'Keyset cursor — return notifications after this id (newest-first order). Supplied by the `Link: rel="next"` header.',
        },
      ],
      responses: {
        "200": {
          description: "Notification list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            Link: { $ref: "#/components/headers/Link" },
          },
          content: {
            "application/json": {
              // CASING / envelope: this list intentionally does NOT use the
              // standard `{ object: "list", data, hasMore }` envelope. It is a
              // keyset (cursor) list paged via the `Link: rel="next"` header, so
              // there is no `object` discriminator and the flag is snake_case
              // `has_more` (matching the runtime serializer in
              // `services/state/notifications.ts:listNotifications`, consumed by
              // `routes/notifications.ts` → `setCursorLinkHeader`). Spec==runtime
              // is the hard invariant; documented divergence, not to be
              // "normalized" to the offset-list envelope.
              schema: {
                type: "object",
                required: ["data", "has_more"],
                properties: {
                  data: { type: "array", items: notificationObject },
                  has_more: {
                    type: "boolean",
                    description: "True when another page follows — page via the Link header cursor",
                  },
                },
              },
              example: {
                data: [
                  {
                    id: "550e8400-e29b-41d4-a716-446655440000",
                    type: "run_completed",
                    run_id: "run_cm4jkl012",
                    payload: { agent_id: "@acme/email-sorter", status: "success" },
                    read_at: null,
                    created_at: "2026-01-15T10:31:12Z",
                  },
                ],
                has_more: false,
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
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
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
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
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/notifications/{id}/read": {
    put: {
      operationId: "markNotificationReadById",
      tags: ["Notifications"],
      summary: "Mark a notification as read",
      description:
        "Marks a single notification read for the current recipient. Idempotent (204 even if already read); returns 404 when the notification does not belong to the caller.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "Notification id",
        },
      ],
      responses: {
        "204": {
          description: "Notification marked as read (idempotent — 204 even if it was already read)",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/notifications/read/{runId}": {
    put: {
      // Keeps the operationId the by-run endpoint shipped with (baseline.json)
      // so operationId-keyed SDK consumers don't silently retarget when the
      // new by-id endpoint was added — see PR review. The by-id path took a
      // fresh `markNotificationReadById` instead.
      operationId: "markNotificationRead",
      tags: ["Notifications"],
      summary: "Mark a run's notification as read",
      description:
        "Mark the caller's notification for a run read, keyed by run id — complements `PUT /api/notifications/{id}/read` for callers that hold a run id but not the notification id. Idempotent: a missing run or non-recipient is a no-op, always 204.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "runId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Notification marked as read (idempotent — 204 even if it was already read)",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/notifications/read-all": {
    put: {
      operationId: "markAllNotificationsRead",
      tags: ["Notifications"],
      summary: "Mark all notifications as read",
      description:
        "Marks all unread notifications as read for the current user. Bulk mutation — returns a documented operation result ({ updated_count }), not a resource.",
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
                  updated_count: {
                    type: "integer",
                    description: "Number of notifications marked as read",
                  },
                },
                required: ["updated_count"],
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
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
