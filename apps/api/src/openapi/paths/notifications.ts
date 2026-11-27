// SPDX-License-Identifier: Apache-2.0

import { runAlertStatusValues } from "@appstrate/db/schema";
import { CREDENTIAL_DEATH_CAUSES } from "@appstrate/core/sidecar-types";
import { STD_RESPONSE_HEADERS } from "../headers.ts";
import { ORG_READ_REACH } from "../parameters.ts";

/**
 * One notification kind. `type` is a `const`, which discriminates the `oneOf`
 * below by itself — a `discriminator` over inline branches selects nothing.
 */
function notificationOf(kind: string, payload: Record<string, unknown>) {
  return {
    type: "object",
    required: ["id", "spaceId", "type", "runId", "payload", "read_at", "createdAt"],
    properties: {
      id: { type: "string", format: "uuid", description: "Notification id" },
      spaceId: {
        type: "string",
        description:
          "The space it was written in: its run, and its own read (`GET /api/notifications/{id}`), are that space's.",
      },
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
 * The feed's entries: what needs the recipient's attention, decided when it is
 * written. A finished run is notified only when it failed or timed out; its
 * read state (`unread` on a run) is served with the runs.
 */
const notificationObject = {
  oneOf: [
    notificationOf("run_failed", {
      required: ["packageId", "agent_name", "status"],
      properties: {
        packageId: {
          type: ["string", "null"],
          description: "The run's agent; null once the agent is deleted.",
        },
        agent_name: {
          type: ["string", "null"],
          description:
            "The agent's name as stamped on the run, for display when the agent is no longer listed (switched off in the space, deleted).",
        },
        status: { type: "string", enum: [...runAlertStatusValues] },
      },
    }),
    notificationOf("agent_message", {
      required: ["packageId", "agent_name", "title", "message"],
      properties: {
        packageId: {
          type: ["string", "null"],
          description:
            "The agent of the run that sent it; null when the run no longer references its agent.",
        },
        agent_name: {
          type: ["string", "null"],
          description:
            "The agent's name as stamped on the run, for display when the agent is not listed (an inline run, an agent switched off in the space or deleted).",
        },
        title: { type: "string", description: "Headline the agent wrote (`notify` tool)." },
        message: { type: "string", description: "Body the agent wrote (`notify` tool)." },
      },
    }),
    notificationOf("credential_needs_reconnection", {
      required: ["packageId", "integration_name", "label", "cause"],
      properties: {
        packageId: { type: "string", description: "The connection's integration (`@scope/name`)." },
        integration_name: {
          type: "string",
          description: "The integration's display name as stamped when the notice was written.",
        },
        label: { type: "string", description: "The connection's label." },
        cause: {
          type: "string",
          enum: [...CREDENTIAL_DEATH_CAUSES],
          description: "Why the credential is dead.",
        },
      },
    }),
  ],
};

/** The query of `GET /api/notifications` and `GET /api/orgs/{orgId}/notifications`. */
const notificationListQueryParameters = [
  {
    name: "unread",
    in: "query",
    required: false,
    schema: { type: "boolean" },
    description:
      "When true, only unread notifications are returned. A value that is neither `true` nor `false` is rejected with `400`, as is any parameter this list does not name.",
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
];

/** One page of the feed, the answer of both list routes. */
const notificationListPageResponses = {
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
              spaceId: "spc_8f14e45fceea167a5a36dedd4bea2543",
              type: "agent_message",
              runId: "run_8f14e45fceea167a5a36dedd4bea2543",
              payload: {
                packageId: "@acme/email-sorter",
                agent_name: "Email sorter",
                title: "Inbox sorted",
                message: "42 messages filed.",
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
};

/** The unread count, the answer of both count routes. */
const unreadCountResponse = {
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
};

/** One notification, the answer of both single reads. */
const notificationResponse = {
  "200": {
    description: "The notification",
    headers: STD_RESPONSE_HEADERS,
    content: {
      "application/json": {
        schema: notificationObject,
        example: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          spaceId: "spc_8f14e45fceea167a5a36dedd4bea2543",
          type: "agent_message",
          runId: "run_9cd174b7-2dfe-404a-a3f1-cf5efadc9543",
          payload: {
            packageId: "@acme/weekly-report",
            agent_name: "Weekly report",
            title: "Report ready",
            message: "This week's report is in the shared drive.",
          },
          read_at: null,
          createdAt: "2026-01-15T10:31:12Z",
        },
      },
    },
  },
  "400": { $ref: "#/components/responses/ValidationError" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "404": { $ref: "#/components/responses/NotFound" },
};

/** The `id` path parameter of a notification. */
const notificationIdParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
  description: "Notification id",
};

export const notificationsPaths = {
  "/api/notifications": {
    get: {
      operationId: "listNotifications",
      tags: ["Notifications"],
      summary: "List notifications",
      description:
        'Keyset-paginated list of the current recipient\'s notifications, newest first. Follow the `Link: rel="next"` header (`?startingAfter=<id>`) to page. `?unread=true` returns unread only. A finished run is in it only when it failed or timed out; every unread run is `GET /api/runs?unread=true`.',
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        ...notificationListQueryParameters,
      ],
      responses: notificationListPageResponses,
    },
  },
  "/api/orgs/{orgId}/notifications": {
    get: {
      operationId: "listOrgNotifications",
      "x-appstrate-space": { kind: "aggregate" },
      tags: ["Notifications"],
      summary: "List notifications across the organization's spaces",
      description:
        "The current recipient's notifications in every space of the organization where they hold a role, in one keyset-paginated page, newest first. The rule of `GET /api/notifications` holds in each space: the caller's own notifications, no role grant asked. Each item carries its `spaceId`: read one with `GET /api/notifications/{id}` and mark it read with `PUT /api/notifications/{id}/read`, both in that space; `PUT /api/notifications/read-all` reads one space's feed. Takes the query of `GET /api/notifications`. " +
        ORG_READ_REACH,
      parameters: [
        { $ref: "#/components/parameters/OrgIdPath" },
        ...notificationListQueryParameters,
      ],
      responses: notificationListPageResponses,
    },
  },
  "/api/orgs/{orgId}/notifications/unread-count": {
    get: {
      operationId: "getOrgUnreadNotificationCount",
      "x-appstrate-space": { kind: "aggregate" },
      tags: ["Notifications"],
      summary: "Get unread notification count across the organization's spaces",
      description:
        "The number of unread notifications of the current recipient in every space of the organization where they hold a role — the spaces `GET /api/orgs/{orgId}/notifications` lists. " +
        ORG_READ_REACH,
      parameters: [{ $ref: "#/components/parameters/OrgIdPath" }],
      responses: unreadCountResponse,
    },
  },
  "/api/notifications/unread-count": {
    get: {
      operationId: "getUnreadNotificationCount",
      tags: ["Notifications"],
      summary: "Get unread notification count",
      description:
        "Returns the number of unread notifications in the current recipient's feed. Unread runs are counted by `GET /api/runs?unread=true`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      responses: {
        ...unreadCountResponse,
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/notifications/{id}": {
    get: {
      operationId: "getNotification",
      tags: ["Notifications"],
      summary: "Get a notification",
      description:
        "Returns one notification of the current recipient. A pure read: marking it read is `PUT /api/notifications/{id}/read`. Returns 404 when the notification does not belong to the caller.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        notificationIdParameter,
      ],
      responses: notificationResponse,
    },
  },
  "/api/orgs/{orgId}/notifications/{id}": {
    get: {
      operationId: "getOrgNotification",
      "x-appstrate-space": { kind: "aggregate" },
      tags: ["Notifications"],
      summary: "Get a notification in any space of the organization",
      description:
        "One notification of the current recipient, in whichever space of the organization they hold a role in — `GET /api/notifications/{id}` without naming the space. The item carries its `spaceId`, where its page opens and where `PUT /api/notifications/{id}/read` marks it read. 404, the same as for an unknown id, when it is another recipient's or lies in a space the caller does not reach. " +
        ORG_READ_REACH,
      parameters: [{ $ref: "#/components/parameters/OrgIdPath" }, notificationIdParameter],
      responses: notificationResponse,
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
        notificationIdParameter,
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
        "Marks every unread notification of the current recipient's feed read. It leaves the runs unread: `PUT /api/runs/read-all` reads them, and their failure notices with them. Bulk mutation — returns a documented operation result ({ updated_count }), not a resource.",
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
};
