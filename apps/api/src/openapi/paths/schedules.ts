// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS } from "../headers.ts";

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
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Schedule" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
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
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Schedule" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
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
                generation_config_override: {
                  $ref: "#/components/schemas/ModelGenerationSettings",
                  description:
                    "Temperature/reasoning overrides applied to every run fired by this schedule.",
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
                    "Which agent definition every run triggered by this schedule executes: `draft`, `published`, or a version spec (exact version, dist-tag, or semver range). Omitting it is identical to `published` (latest published version; the working copy is opt-in via `draft` only). The pinned definition (manifest + prompt) is resolved at each fire — a schedule inheriting (`published`) on a never-published agent skips the fire and logs a warning until a version is published or `draft` is pinned.",
                },
                connection_overrides: {
                  type: "object",
                  description:
                    'Per-integration connection picks frozen on the schedule row (flat-connections mechanism #3). Shape: `{ "@scope/integration": "<connection_id>" }`. Loses to admin pins (#1), beats actor-fallback (#4). Stored on `package_schedules.connection_overrides` and replayed on every fire. Values must be non-empty: an empty id is falsy at the connection resolver, so it would skip the pin in silence on every fire instead of failing here.',
                  additionalProperties: { type: "string", minLength: 1 },
                },
                dependency_overrides: {
                  type: "object",
                  description:
                    'Per-dependency version overrides frozen on the schedule row (#666/#686). Shape: `{ "@scope/dep": "draft" | "<semver|dist-tag>" }`; keys may name a declared skill OR integration. Forwarded to each fired run so it resolves dependencies exactly as the schedule froze them. Each value must be `draft` or a resolvable version spec (semver range, exact version, or dist-tag); the protected tags `latest` and `published` are refused at this write rather than failing at every fire.',
                  additionalProperties: { type: "string" },
                },
                actor: {
                  type: "object",
                  description:
                    "Execution identity for runs this schedule fires (#738). Provide exactly one of `user_id` (an org member) or `end_user_id` (an end-user of this application). Omit to default to the calling identity. Requires `schedules:write`.",
                  properties: {
                    user_id: { type: "string" },
                    end_user_id: { type: "string" },
                  },
                  oneOf: [{ required: ["user_id"] }, { required: ["end_user_id"] }],
                },
              },
              // An unknown field is a 400, never a silent drop — the same rule
              // the other launch bodies publish (`paths/runs.ts`). It matters
              // most here: a schedule FREEZES this body and replays it on every
              // fire, so a stripped field is a wrong run forever.
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Schedule created",
          headers: STD_RESPONSE_HEADERS,
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
                generation_config_override: null,
                model_id_override: null,
                proxy_id_override: null,
                version_override: null,
                connection_overrides: null,
                dependency_overrides: null,
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { $ref: "#/components/responses/RateLimited" },
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
          headers: STD_RESPONSE_HEADERS,
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
                generation_config_override: null,
                model_id_override: null,
                proxy_id_override: null,
                version_override: "1.2.0",
                connection_overrides: null,
                dependency_overrides: null,
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
        "403": { $ref: "#/components/responses/Forbidden" },
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
                generation_config_override: {
                  oneOf: [
                    { $ref: "#/components/schemas/ModelGenerationSettings" },
                    { type: "null" },
                  ],
                  description:
                    "Temperature/reasoning overrides for scheduled runs. Pass null to clear.",
                },
                model_id_override: { type: ["string", "null"] },
                proxy_id_override: { type: ["string", "null"] },
                version_override: {
                  type: ["string", "null"],
                  description:
                    "Version selector (`draft` | `published` | version spec). Pass `null` to clear (falls back to the default `published` — latest published version; the working copy is opt-in via `draft` only).",
                },
                connection_overrides: {
                  type: ["object", "null"],
                  description:
                    "Per-integration connection picks frozen on the schedule. Pass `null` to clear. Values must be non-empty — same rule as on create.",
                  additionalProperties: { type: "string", minLength: 1 },
                },
                dependency_overrides: {
                  type: ["object", "null"],
                  description:
                    'Per-dependency version overrides frozen on the schedule (#666/#686). Shape: `{ "@scope/dep": "draft" | "<semver|dist-tag>" }`; skill or integration ids. Pass `null` to clear. Each value must be `draft` or a resolvable version spec — same rule as on create.',
                  additionalProperties: { type: "string" },
                },
                actor: {
                  type: "object",
                  description:
                    "Re-point the schedule's execution identity (#738). Provide exactly one of `user_id` (an org member) or `end_user_id` (an end-user of this application). Omit to leave the actor unchanged — it cannot be cleared. Changing the actor resets frozen `connection_overrides` unless this patch also supplies them. Requires `schedules:write`.",
                  properties: {
                    user_id: { type: "string" },
                    end_user_id: { type: "string" },
                  },
                  oneOf: [{ required: ["user_id"] }, { required: ["end_user_id"] }],
                },
              },
              // An unknown field is a 400, never a silent drop — the same rule
              // the other launch bodies publish (`paths/runs.ts`). It matters
              // most here: a schedule FREEZES this body and replays it on every
              // fire, so a stripped field is a wrong run forever.
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Schedule updated",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Schedule" },
            },
          },
        },
        "400": {
          description:
            "Validation error. Possible causes: missing/invalid cron expression or invalid input.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
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
        "204": {
          description: "Schedule deleted",
          headers: STD_RESPONSE_HEADERS,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
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
        { $ref: "#/components/parameters/Offset" },
      ],
      responses: {
        "200": {
          description: "Paginated run list",
          headers: STD_RESPONSE_HEADERS,
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
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
} as const;
