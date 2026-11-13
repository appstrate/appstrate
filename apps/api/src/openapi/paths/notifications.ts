// SPDX-License-Identifier: Apache-2.0

import { packageTypeValues } from "@appstrate/db/schema";
import { STD_RESPONSE_HEADERS } from "../headers.ts";

/**
 * One notification kind. `type` is a `const`, which discriminates the `oneOf`
 * below by itself — a `discriminator` over inline branches selects nothing.
 */
function notificationOf(kind: string, payload: Record<string, unknown>) {
  return {
    type: "object",
    required: ["id", "type", "runId", "payload", "read_at", "createdAt"],
    properties: {
      id: { type: "string", format: "uuid", description: "Notification id" },
      type: { type: "string", const: kind },
      runId: {
        type: ["string", "null"],
        description: "Originating run id, when the notification references one",
      },
      payload: {
        type: ["object", "null"],
        additionalProperties: false,
        description: "Render-without-join data.",
        ...payload,
      },
      read_at: {
        type: ["string", "null"],
        format: "date-time",
        description: "When the recipient marked it read; null if unread",
      },
      createdAt: { type: "string", format: "date-time" },
    },
  };
}

/**
 * The feed's entries. A finished run is not one: its read state is served with
 * the runs (`unread` on a run, `GET /api/runs?unread=true`).
 */
const notificationObject = {
  oneOf: [
    notificationOf("package_shared", {
      required: ["packageId", "package_type", "shared_by_name"],
      properties: {
        packageId: { type: "string" },
        package_type: { type: "string", enum: [...packageTypeValues] },
        shared_by_name: { type: "string" },
      },
    }),
  ],
};

export const notificationsPaths = {
  "/api/notifications": {
    get: {
      operationId: "listNotifications",
      tags: ["Notifications"],
      summary: "List notifications",
      description:
        'Keyset-paginated list of the current recipient\'s notifications, newest first. Follow the `Link: rel="next"` header (`?startingAfter=<id>`) to page. `?unread=true` returns unread only. A finished run is not in the feed: see `GET /api/runs?unread=true`.',
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
            ...STD_RESPONSE_HEADERS,
            Link: { $ref: "#/components/headers/Link" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: notificationObject },
                  hasMore: {
                    type: "boolean",
                    description: "True when another page follows — page via the Link header cursor",
                  },
                },
              },
              example: {
                object: "list",
                data: [
                  {
                    id: "550e8400-e29b-41d4-a716-446655440000",
                    type: "package_shared",
                    runId: null,
                    payload: {
                      packageId: "@acme/email-sorter",
                      package_type: "agent",
                      shared_by_name: "Ada Lovelace",
                    },
                    read_at: null,
                    createdAt: "2026-01-15T10:31:12Z",
                  },
                ],
                hasMore: false,
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
      description:
        "Returns the number of unread notifications in the current recipient's feed (finished runs excluded: `GET /api/runs?unread=true`).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      responses: {
        "200": {
          description: "Unread count",
          headers: STD_RESPONSE_HEADERS,
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
  "/api/notifications/{id}/read": {
    put: {
      operationId: "markNotificationReadById",
      tags: ["Notifications"],
      summary: "Mark a notification as read",
      description:
        "Marks a single notification read for the current recipient. Idempotent (204 even if already read); returns 404 when the notification does not belong to the caller.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
          headers: STD_RESPONSE_HEADERS,
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
        "Marks every unread notification of the current recipient's feed read (finished runs excluded: `PUT /api/runs/read-all`). Bulk mutation — returns a documented operation result ({ updated_count }), not a resource.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      responses: {
        "200": {
          description: "Update result",
          headers: STD_RESPONSE_HEADERS,
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
