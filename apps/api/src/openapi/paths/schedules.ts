// SPDX-License-Identifier: Apache-2.0

import { REQUEST_ID_ONLY_HEADERS, STD_RESPONSE_HEADERS } from "../headers.ts";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { connectionIdSetJsonSchema } from "./integrations.ts";

/** The 409 both schedule writes answer when an armed schedule leaves a connection choice open. */
const scheduleConnectionNotChosen = {
  description:
    "`missing_integration_connection` — the schedule is (or stays) enabled and a fire would not know which connection to use for an integration: its actor holds several, or only connections other members share, and `connection_overrides` names none. An unattended run cannot ask, so the choice is made at this write. `errors[]` carries one `must_choose_connection` item per such integration (`field: integrations.<id>`), with `candidate_connections` to name in `connection_overrides` — or `override_connection_unavailable` when a set `connection_overrides` names a connection the actor cannot reach (deleted, unshared, or another identity's), which only a new pick clears — or `override_outranked` when a set in `connection_overrides` names a connection outside the set an admin pin or an enforced org default binds for that integration, which outranks it (name only connections of that set, or drop the override) — or `auth_serves_no_selected_tool` when the schedule's own `connection_overrides` binds a connection on an auth exposing none of the agent's selected tools (`connection_id` names it; bound by a pin or default instead, it is accepted here). Judged for the schedule's actor against the definition it fires (`version_override`). A caller writing a schedule whose actor is ANOTHER MEMBER sees and binds only what both reach: `candidate_connections` lists only connections shared in the space — possibly none, in which case the actor pins one of their own for the agent or an admin pins one — and, on every write (enabled or not), a `connection_overrides` set naming a connection that is not shared is refused as `override_connection_unavailable`, the same answer whatever the id; a set is exempt only when this write changes neither the actor nor that set, and an item about a connection of that set that is not shared names no label or account. For an END-USER actor the caller picks among all of its connections and names one in `connection_overrides`. Every other connection problem (not connected, needs reconnection, missing scopes, inactive integration) is accepted here: it is repaired without editing the schedule, and a fire it still blocks records a failed run. A non-required integration a fire would start without is reported in the success body's `warnings` instead.",
  headers: REQUEST_ID_ONLY_HEADERS,
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/ProblemDetail" },
    },
  },
};

export const schedulesPaths = {
  "/api/schedules": {
    get: {
      operationId: "listSchedules",
      tags: ["Schedules"],
      summary: "List all schedules",
      description: "List all schedules across all agents for the organization.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
        { $ref: "#/components/parameters/XSpaceId" },
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
        { $ref: "#/components/parameters/XSpaceId" },
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
                    "Which agent definition every run triggered by this schedule executes: `draft`, `published`, or a version spec (exact version, dist-tag, or semver range). Omitting it is identical to `published` (latest published version; the working copy is opt-in via `draft` only). `draft` requires WRITE authority on the agent at THIS write — `403 draft_not_writable` otherwise — and is not re-checked at fire time, the way `connection_overrides` are frozen here too. The selected definition (manifest + prompt) is resolved at each fire — a schedule inheriting (`published`) on a never-published agent skips the fire and logs a warning until a version is published or `draft` is selected.",
                },
                connection_overrides: {
                  type: "object",
                  description: `Per-integration connection sets frozen on the schedule row (the launch-override layer of every fire). Map of sets: \`{ "@scope/integration": ["<connection_id>", ...] }\`, 0..${MAX_CONNECTIONS_PER_INTEGRATION} per integration, always an ARRAY; \`[]\` fires without the integration (see the set schema). Cascade, first layer with a set wins: admin pin → enforced org default → launch override (this run's picks, or the firing schedule's — a scheduled fire carries no run override) → member pin → soft org default → fallback (the schedule actor's single OWN connection — a connection shared by another member is never bound without an explicit pick). Under an admin pin or an enforced org default the set must name only connections of that governing set (\`[]\` included), which it then narrows (\`override_outranked\` otherwise, see 409). Stored on \`package_schedules.connection_overrides\` and replayed on every fire. Ids that are not uuids are refused here, and so are a key that names no integration the fired agent declares and \`[]\` on an integration it marks \`required\` (400 \`invalid_request\`, \`param: connection_overrides\`).`,
                  additionalProperties: connectionIdSetJsonSchema,
                },
                dependency_overrides: {
                  type: "object",
                  description:
                    'Per-dependency version overrides frozen on the schedule row (#666/#686). Shape: `{ "@scope/dep": "draft" | "<semver|dist-tag>" }`; keys may name a declared skill OR integration. Forwarded to each fired run so it resolves dependencies exactly as the schedule froze them. Each value must be `draft` or a resolvable version spec (semver range, exact version, or dist-tag); the protected tags `latest` and `published` are refused at this write rather than failing at every fire. A `draft` entry requires WRITE authority on THAT dependency, proved at THIS write (`403 draft_not_writable` naming it) and never re-checked at fire time — the authority belongs to the principal who wrote the schedule, frozen exactly as `connection_overrides` are. A key that names no declared skill or integration of the effective manifest is a `400` naming the key, and it is raised BEFORE the authority gate — a typo is a malformed request, not a missing grant.',
                  additionalProperties: { type: "string" },
                },
                actor: {
                  type: "object",
                  description:
                    "Execution identity for runs this schedule fires (#738). Provide exactly one of `userId` (an org member) or `endUserId` (an end-user of this space). Omit to default to the calling identity. The actor must be able to run agents in this space (the check every fire repeats) — else `400`. Requires `schedules:write`; naming ANOTHER member (`userId` other than the caller's) also requires the org role owner or admin on the user's own credential (an API key or a third-party OAuth client is refused) — else `403 forbidden` with `param: actor`.",
                  properties: {
                    userId: { type: "string" },
                    endUserId: { type: "string" },
                  },
                  // Closed like the body around it: a typo here is stripped by
                  // an open object, the `oneOf` still counts one key, and the
                  // schedule freezes onto the wrong identity on every fire.
                  additionalProperties: false,
                  oneOf: [{ required: ["userId"] }, { required: ["endUserId"] }],
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
          description:
            "Schedule created, plus `warnings`: the integrations its fires would start without, judged for its actor — empty when the caller writes it for another member, whose connections are theirs to manage.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/Schedule" },
                  { $ref: "#/components/schemas/LaunchWarnings" },
                ],
              },
              example: {
                id: "sched_cm1abc456def789",
                packageId: "@acme/email-sorter",
                userId: "usr_r3t5w8y1z6",
                endUserId: null,
                orgId: "org_r3t5w8y1z6",
                spaceId: "spc_9c1f4a2e-7b30-4d58-9a61-2e5c8f0b3d47",
                name: "Weekday morning sort",
                enabled: true,
                disabled_reason: null,
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
                running_runs: 0,
                unread_count: 0,
                last_run_number: 0,
                warnings: [],
              },
            },
          },
        },
        "400": {
          description:
            "Validation error. Possible causes: missing/invalid cron expression (`code: invalid_cron_expression`), a timezone `cron-parser` cannot schedule against (`code: invalid_timezone`, `param: timezone`), invalid input, agent has file inputs (cannot be scheduled), or an actor that cannot run agents in this space (`code: schedule_actor_invalid`, `param: actor`).",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          $ref: "#/components/responses/Forbidden",
          description:
            "Insufficient permissions — including `forbidden` with `param: actor` when a caller who is not an org owner or admin on the user's own credential (an API key or a third-party OAuth client never is) names another member as `actor`, and `draft_not_writable` when `version_override` is `draft` and the caller cannot WRITE the agent, or a `dependency_overrides` entry is `draft` on a dependency they cannot WRITE (the message names it). Authority is checked at this write; the scheduler does not re-check at fire time.",
        },
        // Shared with `PATCH /api/schedules/{id}`: both writes resolve the
        // manifest the schedule will FIRE, so both refuse a never-published
        // agent with `no_published_version`. Arming a schedule is an execution
        // decision, so this door also carries the activation refusal — LISTING
        // an agent's schedules does not.
        "404": {
          $ref: "#/components/responses/NoPublishedVersion",
          description:
            "`no_published_version` when the agent has never been published, `agent_not_found` when this space holds no placement for it, `agent_not_active_in_space` when it holds one that is switched OFF (switch it back on with `POST /api/spaces/{spaceId}/packages`).",
        },
        "409": scheduleConnectionNotChosen,
        "422": { $ref: "#/components/responses/VersionArtifactUnavailable" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
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
        { $ref: "#/components/parameters/XSpaceId" },
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
                spaceId: "spc_9c1f4a2e-7b30-4d58-9a61-2e5c8f0b3d47",
                name: "Weekday morning sort",
                enabled: true,
                disabled_reason: null,
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
                running_runs: 0,
                unread_count: 2,
                last_run_number: 12,
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    patch: {
      operationId: "updateSchedule",
      tags: ["Schedules"],
      summary: "Update a schedule",
      description:
        "Update a cron schedule (expression, timezone, enabled state, or input). Merge semantics (RFC 7396): an absent field is left unchanged, `null` clears a nullable one. A schedule whose actor is ANOTHER platform member than the caller lends that member's connections to every run, so any patch of it — whatever the fields, enabling and disabling included — requires the org role owner or admin on the user's own credential, never an API key or a third-party OAuth client (else `403 forbidden`); schedules running as the caller or as an end user need `schedules:write` only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
                    "Version selector (`draft` | `published` | version spec). Pass `null` to clear (back to the latest published version; the working copy is opt-in via `draft` only). `draft` requires WRITE authority on the agent, but only when this patch MOVES the selector: re-sending the value the row already holds decides nothing and is never refused, so a member editing the cron of someone else's draft schedule is not asked for an authority the request does not exercise.",
                },
                connection_overrides: {
                  type: ["object", "null"],
                  description: `Per-integration connection sets frozen on the schedule, one array of 0..${MAX_CONNECTIONS_PER_INTEGRATION} connection ids per integration. Pass \`null\` to clear. Same array shape, same bounds and same cascade layer as on create. Its keys are judged against the definition the row fires after the patch, whenever the map or \`version_override\` moves: a key it does not declare, or \`[]\` on an integration it marks \`required\`, is a 400 \`invalid_request\`.`,
                  additionalProperties: connectionIdSetJsonSchema,
                },
                dependency_overrides: {
                  type: ["object", "null"],
                  description:
                    'Per-dependency version overrides frozen on the schedule (#666/#686). Shape: `{ "@scope/dep": "draft" | "<semver|dist-tag>" }`; skill or integration ids. Pass `null` to clear. Each value must be `draft` or a resolvable version spec — same rule as on create. WRITE authority is proved per KEY and only for the keys this patch MOVES: a `draft` entry whose value the row already holds was proved at the write that introduced it, and re-sending it decides nothing.',
                  additionalProperties: { type: "string" },
                },
                actor: {
                  type: "object",
                  description:
                    "Re-point the schedule's execution identity (#738). Provide exactly one of `userId` (an org member) or `endUserId` (an end-user of this space). Omit to leave the actor unchanged — it cannot be cleared. Changing the actor resets frozen `connection_overrides` unless this patch also supplies them. Requires `schedules:write`; changing it to ANOTHER member (`userId` other than the caller's) also requires the org role owner or admin on the user's own credential (an API key or a third-party OAuth client is refused) — else `403 forbidden` with `param: actor`. A schedule already running as another member takes the same for any patch, this field included.",
                  properties: {
                    userId: { type: "string" },
                    endUserId: { type: "string" },
                  },
                  // Closed like the body around it: a typo here is stripped by
                  // an open object, the `oneOf` still counts one key, and the
                  // schedule freezes onto the wrong identity on every fire.
                  additionalProperties: false,
                  oneOf: [{ required: ["userId"] }, { required: ["endUserId"] }],
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
          description:
            "Schedule updated, plus `warnings`: the integrations its fires would start without, judged for its actor — empty while the schedule is disabled, and when the caller writes it for another member, whose connections are theirs to manage.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/Schedule" },
                  { $ref: "#/components/schemas/LaunchWarnings" },
                ],
              },
            },
          },
        },
        "400": {
          description:
            "Validation error. Possible causes: missing/invalid cron expression (`code: invalid_cron_expression`), a timezone `cron-parser` cannot schedule against (`code: invalid_timezone`, `param: timezone`), invalid input, or an enabled schedule whose actor cannot run agents in this space (`code: schedule_actor_invalid`, `param: actor`).",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          $ref: "#/components/responses/Forbidden",
          description:
            "Insufficient permissions — including `forbidden` when a caller who is not an org owner or admin on the user's own credential (an API key or a third-party OAuth client never is) patches a schedule running as another member (any field), or (with `param: actor`) changes `actor` to another member, and `draft_not_writable` when the patch CHANGES `version_override` to `draft` and the caller cannot WRITE the agent, or changes a `dependency_overrides` entry to `draft` on a dependency they cannot WRITE. A value identical to the one already stored is an echo, not a decision, and is not judged.",
        },
        // Two causes, both on this one response: `loadScheduleOr404` runs
        // first (unknown schedule id — the dominant 404 here), and a patch
        // carrying `input` or `version_override` additionally runs the same
        // `assertScheduleTargetValid` the create route does, so repointing or
        // revalidating onto a never-published agent gets `no_published_version`
        // here too. The shared component's description names both.
        "404": { $ref: "#/components/responses/NoPublishedVersion" },
        // `must_choose_connection` / `override_outranked` / `auth_serves_no_selected_tool` need the
        // schedule to stay enabled; `override_connection_unavailable` on another member's schedule (an owner/admin
        // write) is judged on every write, disabled or not; the concurrent-write one can be raised
        // by any patch.
        "409": {
          ...scheduleConnectionNotChosen,
          description: `${scheduleConnectionNotChosen.description} — Or \`schedule_modified_concurrently\`: the schedule was written since this patch read it (\`updated_at\` moved: another patch, a connection delete or unshare, a fire disabling it for an actor who lost access, the actor's removal from the organization, or a lock on one of its input fields); nothing was written — reload the schedule and retry.`,
        },
        "422": { $ref: "#/components/responses/VersionArtifactUnavailable" },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
    delete: {
      operationId: "deleteSchedule",
      tags: ["Schedules"],
      summary: "Delete a schedule",
      description:
        "Permanently delete a cron schedule. A schedule whose actor is ANOTHER platform member than the caller requires the org role owner or admin on the user's own credential, never an API key or a third-party OAuth client (else `403 forbidden`), on top of `schedules:delete`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Schedule deleted",
          headers: STD_RESPONSE_HEADERS,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          $ref: "#/components/responses/Forbidden",
          description:
            "Insufficient permissions — including `forbidden` when a caller who is not an org owner or admin on the user's own credential (an API key or a third-party OAuth client never is) deletes a schedule running as another member.",
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/schedules/{id}/runs": {
    get: {
      operationId: "listScheduleRuns",
      tags: ["Schedules"],
      summary: "List runs for a schedule",
      description:
        "List recent runs triggered by a specific schedule. Takes `schedules:read` AND a run read permission: the rows are runs, so `runs:read` lists the ones the caller launched — including the runs of the caller's own schedules — and `runs:read-all` the whole space. A credential holding `schedules:read` alone is rejected with 403.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
