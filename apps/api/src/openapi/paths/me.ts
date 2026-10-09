// SPDX-License-Identifier: Apache-2.0

import { packageSourceValues } from "@appstrate/db/schema";
import { STD_RESPONSE_HEADERS } from "../headers.ts";
import {
  agentPackageIdParam,
  connectionIdSetJsonSchema,
  connectionScopeSchema,
  connectionSetRefusals,
  connectionUpdateConflicts,
  connectionUpdateDescription,
  connectionUpdateRefusals400,
  connectionUpdateRequestBody,
  integrationConnectionSchema,
  integrationPackageIdParam,
  lockedBySchema,
} from "./integrations.ts";

const namedSpaceSchema = {
  type: "object",
  required: ["id", "name"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
  },
} as const;

/**
 * User-scoped identity routes (`/api/me/*`).
 *
 * `/api/me/orgs` is the prerequisite to picking an org and setting
 * `X-Org-Id` — every auth method that represents a single user (cookie
 * session, API key, OAuth2 instance/dashboard/end-user JWTs) is accepted,
 * and the route does NOT require `X-Org-Id` itself.
 *
 * The other routes in this namespace run inside org (or space) context.
 */

export const mePaths = {
  "/api/me/orgs": {
    get: {
      operationId: "listMyOrgs",
      tags: ["Profile"],
      summary: "List orgs the authenticated caller belongs to",
      description:
        "Returns every org the caller can access. The user's own credential (cookie session, CLI " +
        "or instance token) sees every org they are a member of. A delegated credential — an API " +
        "key, a third-party OAuth client — sees only its bound org, as does an OIDC end-user JWT " +
        "(the org owning its space). " +
        "**Does NOT require `X-Org-Id`** — this endpoint is the prerequisite to setting it.",
      parameters: [{ $ref: "#/components/parameters/XViewAs" }],
      responses: {
        "200": {
          description: "Orgs accessible to the caller",
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
                    items: {
                      type: "object",
                      required: ["id", "name", "slug", "role", "createdAt"],
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        slug: { type: "string" },
                        role: {
                          type: "string",
                          enum: ["owner", "admin", "member", "guest", "end_user"],
                          description:
                            "Org role for member callers; `end_user` for OIDC end-user JWTs.",
                        },
                        permissions: {
                          type: "array",
                          items: { type: "string" },
                          description:
                            "The caller's ORG-LEVEL effective permissions in this org, ceiling-applied. Absent for OIDC end-user JWTs, which hold no org role.",
                        },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "org_abc123",
                    name: "Acme Corp",
                    slug: "acme",
                    role: "owner",
                    permissions: ["org:read", "org:update", "members:invite"],
                    createdAt: "2026-01-10T08:00:00Z",
                  },
                ],
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ViewAsRefused" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/me/connections": {
    get: {
      operationId: "listMyConnections",
      tags: ["Profile"],
      summary: "List the caller's connections across every org/space",
      description:
        "Unified user-scope view of the caller's integration connections under a " +
        "single shape, grouped by source package. For the user's own credential " +
        "(cookie session, CLI or instance token) it crosses orgs/spaces by " +
        "design — does NOT require `X-Org-Id`. For a delegated or end-user credential " +
        "the list is scoped to its bound organization, and to its space when it pins one — where a " +
        "connection's shares, origin space and reuse count show that space only.",
      responses: {
        "200": {
          description: "Connection groups",
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
                    items: {
                      type: "object",
                      required: [
                        "kind",
                        "source_id",
                        "display_name",
                        "logo",
                        "total_connections",
                        "connections",
                      ],
                      properties: {
                        kind: { type: "string", enum: ["integration"] },
                        source_id: { type: "string" },
                        display_name: { type: "string" },
                        logo: { type: "string" },
                        total_connections: { type: "integer" },
                        connections: {
                          type: "array",
                          items: {
                            type: "object",
                            required: [
                              "connection_id",
                              "kind",
                              "label",
                              "scopes_granted",
                              "connected_at",
                              "needs_reconnection",
                              "expiresAt",
                              "identity",
                              "auth_key",
                              "scope",
                              "shared_spaces",
                              "reused_by_agents",
                              "locked_by",
                              "org",
                              "space",
                              "origin_space",
                            ],
                            properties: {
                              connection_id: { type: "string" },
                              kind: { type: "string", enum: ["integration"] },
                              label: { type: "string" },
                              scopes_granted: { type: "array", items: { type: "string" } },
                              connected_at: { type: "string", format: "date-time" },
                              needs_reconnection: { type: "boolean" },
                              expiresAt: {
                                oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
                              },
                              identity: { type: "string" },
                              reused_by_agents: {
                                type: "integer",
                                description:
                                  "Distinct agents run by the connection's home space (its space, or the one an org-scoped connection was connected from) and by the spaces it is shared into, that declare this integration.",
                              },
                              auth_key: { type: "string" },
                              scope: connectionScopeSchema,
                              shared_spaces: {
                                type: "array",
                                items: namedSpaceSchema,
                                description: "The spaces whose members may use it.",
                              },
                              locked_by: lockedBySchema,
                              org: {
                                type: "object",
                                required: ["id", "name"],
                                properties: {
                                  id: { type: "string" },
                                  name: { type: "string" },
                                },
                              },
                              space: {
                                oneOf: [namedSpaceSchema, { type: "null" }],
                                description:
                                  "The one space a space-scoped connection lives in; `null` for an org-scoped one.",
                              },
                              origin_space: {
                                oneOf: [namedSpaceSchema, { type: "null" }],
                                description:
                                  "The space an org-scoped connection was connected from; `null` for a space-scoped one, or once that space is deleted.",
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/me/integration-pins": {
    get: {
      operationId: "listMyIntegrationPins",
      tags: ["Profile"],
      summary: "List the caller's member-scope integration pins for an agent",
      description:
        "Returns the caller's own integration → connection-set pins for the " +
        "given agent. Used by the agent-page picker to render the collapsed default " +
        "row. Member-only; end-user callers receive an empty list. Requires " +
        "`X-Space-Id`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        {
          name: "agent_package_id",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Agent package id whose pins to list. Omitted, the list is empty — " +
            "the picker renders before it has an agent to ask about.",
        },
      ],
      responses: {
        "200": {
          description: "Member pins for the agent, or an empty list when no agent was named",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    // `listMemberPinsForAgent` projects to exactly these two
                    // fields (NOT the IntegrationPin the PUT route emits) —
                    // keep the list item minimal.
                    items: {
                      type: "object",
                      required: ["integration_package_id", "connection_ids"],
                      properties: {
                        integration_package_id: { type: "string" },
                        connection_ids: connectionIdSetJsonSchema,
                      },
                    },
                  },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/me/integration-pins/{agentPackageId}/integrations/{integrationPackageId}": {
    put: {
      operationId: "upsertMyIntegrationPin",
      tags: ["Profile"],
      summary: "Pin connections for the caller's runs of an agent",
      description:
        "Persists the caller's preference for an integration on this agent. " +
        "Sits at cascade layer 4 — wins over a soft org default and the fallback, loses " +
        "to an admin pin, an enforced org default and the launch override (the run's or " +
        "the schedule's `connection_overrides`). " +
        "The body carries the WHOLE set and this write replaces it — `[]` pins none: the run " +
        "starts without the integration, or is refused when the agent requires it; `DELETE` " +
        "clears the pin. " +
        "Idempotent — repeated calls rewrite the same set. Path-addressed like the admin " +
        "pins; encode each id with `encodePackageIdPath`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        agentPackageIdParam,
        integrationPackageIdParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["connection_ids"],
              properties: {
                connection_ids: connectionIdSetJsonSchema,
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Member pin set",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/IntegrationPin" },
            },
          },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description: `Refused: ${connectionSetRefusals}.`,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          $ref: "#/components/responses/Forbidden",
          description:
            "The credential's scope ceiling lacks `integrations:connect`, or the caller is an end-user — end-users have no member pins (`forbidden`).",
        },
        "404": {
          $ref: "#/components/responses/NotFound",
          description:
            "A connection id that is unknown, of another integration or space, or neither owned by the caller nor shared — one answer for all, so an id cannot be probed — or the agent is not active in this space.",
        },
      },
    },
    delete: {
      operationId: "deleteMyIntegrationPin",
      tags: ["Profile"],
      summary: "Clear the caller's pin on a (agent, integration)",
      description:
        "Removes the caller's member pin so the resolver falls back to layers 5-6 " +
        "(soft org default, then accessible connections). Idempotent — 204 even when no row exists.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        agentPackageIdParam,
        integrationPackageIdParam,
      ],
      responses: {
        "204": { description: "Pin cleared (or never existed)" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          $ref: "#/components/responses/Forbidden",
          description:
            "The credential's scope ceiling lacks `integrations:connect`, or the caller is an end-user — end-users have no member pins (`forbidden`).",
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/me/connections/{connectionId}/delete-impact": {
    get: {
      operationId: "getMyConnectionDeleteImpact",
      tags: ["Profile"],
      summary: "The caller's pins and schedules a connection delete would rewrite",
      description:
        "Lists the caller's own member pins and schedules whose connection set names this connection — " +
        "the references `DELETE /api/me/connections/{connectionId}` rewrites — so a client can " +
        "say, before confirming, what each loses. Each set keeps `connection_count - 1` connections; a " +
        "pin left with none is removed (the agent falls back to the default resolution), and a schedule " +
        "override left with none drops that integration AND disables the schedule (`disables: true`) — " +
        "an unattended run never silently falls back to another account; its owner re-picks and " +
        "re-enables it. One schedule entry per (schedule, integration). Other actors' enabled schedules " +
        "naming the connection are disabled by the delete with their overrides kept " +
        "(`disabled_reason: connection_deleted`); they are counted in `other_schedules_disabled_count`, " +
        "never listed. Other members' pins, admin pins and org defaults are not listed: the delete " +
        "leaves them untouched. The lists are " +
        "empty for an id that is not a UUID, unknown, or of a connection the caller does not own. A " +
        "delegated or end-user credential sees its bound organization (and space) only: a connection " +
        "outside it answers empty lists, and only the owner's pins and schedules inside it are listed, " +
        "though the delete also rewrites those outside it. A pinned connection is still " +
        "listed, though its delete answers 409 `connection_pinned`. An end user has no pins.",
      parameters: [
        { name: "connectionId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "References naming the connection",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["pins", "schedules", "other_schedules_disabled_count"],
                properties: {
                  other_schedules_disabled_count: {
                    type: "integer",
                    minimum: 0,
                    description:
                      "How many enabled schedules of actors other than the caller name the connection: the delete disables them (`connection_deleted`) and keeps their overrides. A count only — their names and actors are not the caller's to read. A bound credential counts those of its organization (and space) only. 0 whenever the lists are empty for an unknown, unowned or out-of-scope connection.",
                  },
                  pins: {
                    type: "array",
                    items: {
                      type: "object",
                      required: [
                        "agent_package_id",
                        "agent_display_name",
                        "integration_package_id",
                        "connection_count",
                      ],
                      properties: {
                        agent_package_id: { type: "string" },
                        agent_display_name: { type: "string" },
                        integration_package_id: { type: "string" },
                        connection_count: {
                          type: "integer",
                          minimum: 1,
                          description: "Size of the pinned set before the delete.",
                        },
                      },
                    },
                  },
                  schedules: {
                    type: "array",
                    items: {
                      type: "object",
                      required: [
                        "scheduleId",
                        "schedule_name",
                        "agent_package_id",
                        "agent_display_name",
                        "integration_package_id",
                        "connection_count",
                        "disables",
                      ],
                      properties: {
                        scheduleId: { type: "string" },
                        schedule_name: { type: ["string", "null"] },
                        agent_package_id: { type: "string" },
                        agent_display_name: { type: "string" },
                        integration_package_id: { type: "string" },
                        connection_count: {
                          type: "integer",
                          minimum: 1,
                          description:
                            "Size of the schedule's override set for this integration before the delete.",
                        },
                        disables: {
                          type: "boolean",
                          description:
                            "True when the delete disables this schedule: it is enabled and one of its sets empties.",
                        },
                      },
                    },
                  },
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
  "/api/me/connections/{connectionId}": {
    patch: {
      operationId: "updateMyConnection",
      tags: ["Profile"],
      summary: "Rename one of the caller's own connections and/or set the spaces it is shared into",
      description:
        "The owner's door to the edit `PATCH /api/integrations/{packageId}/connections/{connectionId}` " +
        "makes, wherever the connection lives: an org-scoped connection belongs to no space, so no " +
        "`X-Space-Id` addresses it. Owner only — a governor withdraws a connection from a space through " +
        "the space door. With a delegated or end-user credential, only connections inside its bound " +
        "organization (and space, when it pins one) are reachable. " +
        connectionUpdateDescription,
      parameters: [
        {
          name: "connectionId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: connectionUpdateRequestBody,
      responses: {
        "200": {
          description: "Updated — returns the bare connection resource",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: integrationConnectionSchema } },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description: connectionUpdateRefusals400,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          $ref: "#/components/responses/Forbidden",
          description:
            "The credential's scope ceiling lacks `integrations:connect`; a credential bound to a space edits another space's share or renames a connection not scoped to it; or a requested target — added or kept — blocks user connections for the integration and the caller lacks `integrations:configure` there (`connection_blocked_by_admin`).",
        },
        "404": {
          $ref: "#/components/responses/NotFound",
          description:
            "No connection with this id that the caller owns inside its credential's binding.",
        },
        "409": connectionUpdateConflicts,
      },
    },
    delete: {
      operationId: "deleteMyConnection",
      tags: ["Profile"],
      summary: "Delete one of the caller's own connections (destructive)",
      description:
        "Removes the `integration_connections` row globally. " +
        "Intent is destructive: 'I never want to use this credential anywhere again'. " +
        "Refused with 409 `connection_pinned` while an admin pin or an org default (enforced or soft) " +
        "names the connection: those sets carry no foreign key, so the dead id would fail every consuming " +
        "run. An admin removes it from the pin(s) or default first. A member pin does not block the " +
        "delete. The caller's own " +
        "member pins and schedule overrides drop the connection in the same transaction — a pin it " +
        "empties is removed (the cascade falls back), and a schedule override it empties drops that " +
        "integration and disables the schedule (its job is removed) rather than let it fall back " +
        "unattended; `GET /api/me/connections/{connectionId}/delete-impact` lists them beforehand. " +
        "Another member's pins keep the id, and their next run fails " +
        "(`pinned_connection_unavailable`) until they pick again — a set never shrinks behind its " +
        "owner. Another actor's enabled schedules naming the connection are disabled in the same " +
        "transaction (`disabled_reason: connection_deleted`, jobs removed), their overrides kept: " +
        "while the connection stays unreachable, re-enabling one requires a new choice. " +
        "Delete-impact counts them " +
        "(`other_schedules_disabled_count`). " +
        "Surfaced only from the /connections management page — agent-surface unlinks now " +
        "drop the member pin instead (see `DELETE /api/me/integration-pins/{agentPackageId}/integrations/{integrationPackageId}`). " +
        "With a delegated or end-user credential, only connections inside its bound " +
        "organization (and space, when it pins one) can be deleted (204 with no effect otherwise); " +
        "a credential bound to a space deletes only a connection scoped to it (403 for one serving the " +
        "whole organization).",
      parameters: [
        {
          name: "connectionId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "204": { description: "Connection deleted (or never existed)" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          $ref: "#/components/responses/Forbidden",
          description:
            "The credential's scope ceiling lacks `integrations:disconnect`, or the credential is bound to a space and the connection serves the whole organization.",
        },
        "409": {
          description:
            "Connection is named by an admin pin or an org default (`connection_pinned`)",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/me/connections/{connectionId}/handoff": {
    get: {
      operationId: "getMyConnectionHandoff",
      tags: ["Profile"],
      summary: "What is due on the target when this connection is deleted",
      description:
        "For a connection whose credentials the platform minted, the steps to run on the " +
        "target when deleting it (e.g. removing the installed key) — deleting the connection " +
        "cannot reach the target. Creation-time steps come only from `submitIntegrationConnect`. " +
        "`deferred` is omitted: every step here is deletion-time. Empty for an auth that mints " +
        "nothing, and for an unknown, malformed or not-owned id.",
      parameters: [
        {
          name: "connectionId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Handoff steps due at deletion (possibly empty)",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  hasMore: { type: "boolean" },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/HandoffCommandStep" },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/me/context": {
    get: {
      operationId: "getMyContext",
      tags: ["Profile"],
      summary: "The caller's working context for an AI agent",
      description:
        "Returns the caller's identity, their role in the pinned org, and the integrations " +
        "they could attach when building an agent in the current space (their own, or " +
        "shared into it). One payload powering the chat system prompt, the MCP `get_me` tool, and " +
        "direct API/MCP callers — so an agent can prefer already-connected integrations and " +
        "respect the caller's role (operations beyond it 403 at invoke time). The space is " +
        "the one the credential (API key, token) is bound to — an `X-Space-Id` naming another " +
        "is refused — else the one `X-Space-Id` names; with neither the request is a 400, " +
        "except through the MCP server, which falls back to the org's default space.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      responses: {
        "200": {
          description: "Caller context",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "user",
                  "org",
                  "space",
                  "connections",
                  "recent_runs",
                  "agents",
                  "agents_truncated",
                  "agents_total",
                  "skills",
                  "skills_truncated",
                  "skills_total",
                ],
                properties: {
                  user: {
                    type: "object",
                    required: ["id", "name", "email"],
                    properties: {
                      id: { type: "string" },
                      name: { type: ["string", "null"] },
                      email: { type: ["string", "null"] },
                    },
                  },
                  org: {
                    type: "object",
                    required: ["id", "role"],
                    properties: {
                      id: { type: "string" },
                      role: {
                        type: "string",
                        enum: ["owner", "admin", "member", "guest", "end_user"],
                      },
                      name: {
                        type: ["string", "null"],
                        description: "Human-readable organization name.",
                      },
                      slug: { type: ["string", "null"], description: "Organization slug." },
                    },
                  },
                  space: {
                    type: "object",
                    description:
                      "The space this request resolved to. Every list in this payload is " +
                      "scoped to it. An empty list means nothing of that kind is available to " +
                      "this caller in this space, this is not the space you meant, or the " +
                      "caller's permissions do not cover that list.",
                    required: ["id", "name", "personal"],
                    properties: {
                      id: { type: "string" },
                      name: { type: "string", description: "Human-readable space name." },
                      personal: {
                        type: "boolean",
                        description:
                          "Whether this space is one member's personal space (always " +
                          "`private`, no other members) rather than a team space.",
                      },
                    },
                  },
                  recent_runs: {
                    type: "array",
                    description:
                      "The caller's own most recent runs (actor-scoped), newest first — lets " +
                      "an agent reference a recent or failed run without a discovery round-trip.",
                    items: {
                      type: "object",
                      required: ["packageId", "status"],
                      properties: {
                        packageId: { type: "string" },
                        status: { type: "string" },
                        runNumber: { type: ["integer", "null"] },
                        started_at: { type: ["string", "null"], format: "date-time" },
                        error: {
                          type: ["string", "null"],
                          description: "Failure message for non-success runs, when available.",
                        },
                      },
                    },
                  },
                  connections: {
                    type: "array",
                    description: "Integrations the caller could attach to an agent.",
                    items: {
                      type: "object",
                      required: ["integration_package_id", "name", "source"],
                      properties: {
                        integration_package_id: { type: "string" },
                        name: { type: "string" },
                        source: { type: "string", enum: ["own", "shared", "both"] },
                        version: {
                          type: "string",
                          description:
                            "The integration package's own manifest version, when known. Use it to pin a satisfiable dependencies.integrations range.",
                        },
                        default_tools: {
                          description:
                            "AFPS §4.4 — tool(s) an agent inherits when it declares this integration without an `integrations_configuration.<id>.tools` selection. Absent or `[]` means an agent that declares this integration without its own selection ends up with nothing callable, which publish/import reject and the run aborts on — such an agent must select a tool explicitly. To use any other tool, inspect the full `tool_catalog` via GET /api/integrations/{packageId}.",
                          oneOf: [
                            { type: "array", items: { type: "string" } },
                            { type: "string", enum: ["*"] },
                          ],
                        },
                      },
                    },
                  },
                  agents: {
                    type: "array",
                    description:
                      "Agents the caller can run in the current space (capped). Only " +
                      "present when the caller holds the `agents:run` permission; empty otherwise. " +
                      "When `agents_truncated` is true, the full list is reachable via the " +
                      "`listAgents` operation.",
                    items: {
                      type: "object",
                      required: [
                        "packageId",
                        "display_name",
                        "description",
                        "takes_input",
                        "published",
                        "home_writable",
                        "source",
                      ],
                      properties: {
                        packageId: {
                          type: "string",
                          description: 'Invokable identifier, e.g. "@appstrate/triage".',
                        },
                        display_name: { type: "string" },
                        description: { type: "string" },
                        takes_input: {
                          type: "boolean",
                          description:
                            "Whether the agent declares an input schema with properties.",
                        },
                        published: {
                          type: "boolean",
                          description:
                            "True when the agent has a published version (or is a system agent) — " +
                            "run it via `runAgent` with `version` omitted. False means draft-only: " +
                            "omitting `version` answers 404 `no_published_version`.",
                        },
                        home_writable: {
                          type: "boolean",
                          description:
                            "Whether THIS caller may write the agent, i.e. whether its draft is " +
                            "theirs to run with `version=draft` (403 `draft_not_writable` " +
                            "otherwise). Read with `published`: false/false is an agent this " +
                            "caller cannot execute at all until its author publishes one.",
                        },
                        source: { type: "string", enum: [...packageSourceValues] },
                      },
                    },
                  },
                  agents_truncated: {
                    type: "boolean",
                    description:
                      "True when the agent list was capped (full list via `listAgents`).",
                  },
                  agents_total: {
                    type: "integer",
                    description: "Total runnable agents before the cap.",
                  },
                  skills: {
                    type: "array",
                    description:
                      "Skills the caller could attach to an agent in the current space " +
                      "(capped). A catalogue read, not a runnable hint: only present when the " +
                      "caller holds the `skills:read` permission; empty otherwise. Skills are not run directly — declare them under an agent " +
                      "manifest's `dependencies.skills`. When `skills_truncated` is true, the " +
                      "full list is reachable via the `listSkills` operation.",
                    items: {
                      type: "object",
                      required: [
                        "packageId",
                        "display_name",
                        "description",
                        "version",
                        "published",
                        "home_writable",
                        "source",
                      ],
                      properties: {
                        packageId: {
                          type: "string",
                          description:
                            'Attachable identifier, e.g. "@appstrate/web-research". Declare under dependencies.skills.',
                        },
                        display_name: { type: "string" },
                        description: { type: "string" },
                        version: {
                          type: ["string", "null"],
                          description:
                            "The skill package's own manifest version, when known. Use it to pin a satisfiable dependencies.skills range.",
                        },
                        published: {
                          type: "boolean",
                          description:
                            "True when the skill has a published version (or is a system skill). " +
                            "False means draft-only: a manifest range can select nothing, and only " +
                            "`dependency_overrides` with `draft` reaches its working copy.",
                        },
                        home_writable: {
                          type: "boolean",
                          description:
                            "Whether THIS caller may write the skill, i.e. whether its draft is " +
                            "theirs to run — `dependency_overrides` with `draft` answers 403 " +
                            "`draft_not_writable` otherwise.",
                        },
                        source: { type: "string", enum: [...packageSourceValues] },
                      },
                    },
                  },
                  skills_truncated: {
                    type: "boolean",
                    description:
                      "True when the skill list was capped (full list via `listSkills`).",
                  },
                  skills_total: {
                    type: "integer",
                    description: "Total active skills before the cap.",
                  },
                },
              },
              example: {
                user: { id: "user_abc", name: "Ada Lovelace", email: "ada@acme.com" },
                org: { id: "org_abc123", role: "member", name: "Acme", slug: "acme" },
                space: {
                  id: "spc_5b8c0e13-4f7a-4d92-b3c6-71e0a4d9f582",
                  name: "Sales",
                  personal: false,
                },
                connections: [
                  { integration_package_id: "@appstrate/gmail", name: "Gmail", source: "own" },
                  {
                    integration_package_id: "@appstrate/clickup",
                    name: "ClickUp",
                    source: "shared",
                  },
                ],
                recent_runs: [
                  {
                    packageId: "@appstrate/triage",
                    status: "failed",
                    runNumber: 7,
                    started_at: "2026-06-25T09:12:00.000Z",
                    error: "Gmail token expired",
                  },
                ],
                agents: [
                  {
                    packageId: "@appstrate/triage",
                    display_name: "Inbox Triage",
                    description: "Sorts and labels incoming email.",
                    takes_input: false,
                    published: true,
                    home_writable: false,
                    source: "system",
                  },
                ],
                agents_truncated: false,
                agents_total: 1,
                skills: [
                  {
                    packageId: "@appstrate/web-research",
                    display_name: "Web Research",
                    description: "Multi-source web search and synthesis.",
                    version: "1.2.0",
                    published: true,
                    home_writable: false,
                    source: "system",
                  },
                ],
                skills_truncated: false,
                skills_total: 1,
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
