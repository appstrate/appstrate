// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS } from "../headers.ts";
import {
  APPEARANCE_PROPERTIES,
  EMOJI_ICON_WRITE_RULE,
  ORG_SETTINGS_PROPERTIES,
  SPACE_ROLE_ID_PATTERN,
} from "../schemas.ts";

import { ASSIGNABLE_ORG_ROLES } from "@appstrate/shared-types";
import { ORG_ROLES, SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import {
  APPEARANCE_COLORS,
  ICON_IMAGE_MAX_BYTES,
  ICON_IMAGE_MAX_SIZE,
  ICON_IMAGE_TYPES,
  ICON_MAX_LENGTH,
} from "@appstrate/core/appearance";

/** The two doors that write an organization slug document it once. */
const SLUG_DESCRIPTION =
  "Kebab-case. The scope the organization's uploads, forks and starter agent are created under (`@<slug>/<name>`). The platform's own scopes, `appstrate` (system packages) and `inline` (inline runs' shadow packages), are refused with `400 slug_reserved`; a slug another organization holds with `400 slug_taken`.";

/** Request-body shape of one space assignment — mirrors the `SpaceAssignment` component. */
const SPACE_ASSIGNMENTS_BODY = {
  type: "array",
  description:
    "Space memberships in TEAM spaces, applied when the invitation is accepted. May be empty for every role — the member's own personal space is provisioned at the door, so a `role: guest` invited for a single shared package needs no grant here. Must be empty for `role: admin`, which already runs every team space. An entry naming a `custom_role_id` must name a bundle of this organization, checked when the invitation is WRITTEN (404 otherwise) — deferring a grant is still granting.",
  items: { $ref: "#/components/schemas/SpaceAssignment" },
} as const;

export const organizationsPaths = {
  "/api/orgs": {
    get: {
      operationId: "listOrganizations",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "List user organizations",
      description: "List organizations the current user is a member of, oldest membership first.",
      parameters: [{ $ref: "#/components/parameters/XViewAs" }],
      responses: {
        "200": {
          description: "Organization list",
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
                    items: { $ref: "#/components/schemas/Organization" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "550e8400-e29b-41d4-a716-446655440000",
                    name: "Acme Corp",
                    slug: "acme-corp",
                    icon: null,
                    color: null,
                    role: "owner",
                    permissions: ["org:read", "org:update", "members:invite"],
                    createdAt: "2026-01-10T08:00:00Z",
                    deleting_at: null,
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
    post: {
      operationId: "createOrganization",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Create an organization",
      description:
        "Create a new organization. The current user becomes the owner. The organization is automatically pinned to the current API version.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", minLength: 1 },
                slug: {
                  type: "string",
                  pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$",
                  description: SLUG_DESCRIPTION,
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Organization created",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id", "name", "slug", "icon", "color", "role", "createdAt"],
                properties: {
                  id: { type: "string", format: "uuid" },
                  name: { type: "string" },
                  slug: { type: "string" },
                  ...APPEARANCE_PROPERTIES,
                  role: { type: "string", enum: ["owner"] },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
              example: {
                id: "550e8400-e29b-41d4-a716-446655440001",
                name: "New Organization",
                slug: "new-org",
                icon: null,
                color: null,
                role: "owner",
                createdAt: "2026-01-15T10:30:00Z",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          $ref: "#/components/responses/Forbidden",
          description:
            "Forbidden. `code` is `org_creation_disabled` when the instance sets `AUTH_DISABLE_ORG_CREATION` and the caller is not a platform admin.",
        },
      },
    },
  },
  "/api/orgs/{orgId}": {
    get: {
      operationId: "getOrganization",
      "x-appstrate-space": { kind: "aggregate", permission: "members:read" },
      tags: ["Organizations"],
      summary: "Get organization with members",
      description: "Get organization details including members and pending invitations.",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Organization detail with members and invitations",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgDetail" },
              example: {
                id: "550e8400-e29b-41d4-a716-446655440000",
                name: "Acme Corp",
                slug: "acme-corp",
                icon: null,
                color: null,
                members: [
                  {
                    userId: "usr_abc123",
                    displayName: "Alice",
                    email: "alice@acme.com",
                    role: "owner",
                    joinedAt: "2026-01-10T08:00:00Z",
                    spaces: [
                      {
                        id: "spc_default",
                        name: "Default",
                        source: "org_role",
                        role: { kind: "preset", key: "admin", name: "admin" },
                      },
                    ],
                    personal_space_role: null,
                    personal_space_default_role: { kind: "preset", key: "admin", name: "admin" },
                  },
                  {
                    userId: "usr_def456",
                    displayName: "Bob",
                    email: "bob@acme.com",
                    role: "member",
                    joinedAt: "2026-01-12T10:00:00Z",
                    spaces: [
                      {
                        id: "spc_default",
                        name: "Default",
                        source: "open_space",
                        role: { kind: "preset", key: "operator", name: "operator" },
                      },
                    ],
                    personal_space_role: { preset_role: "builder" },
                    personal_space_default_role: { kind: "preset", key: "admin", name: "admin" },
                  },
                ],
                invitations: [],
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
      operationId: "updateOrganization",
      "x-appstrate-space": { kind: "aggregate", permission: "members:read" },
      tags: ["Organizations"],
      summary: "Update organization",
      description:
        "Update organization name, slug, icon and/or colour. Requires `org:update`. Merge semantics (RFC 7396): an absent field is left unchanged, `null` clears a nullable one. An uploaded image travels as the `icon` itself, a base64 WebP or PNG data URI; the audit log records the first 16 hex digits of its SHA-256 digest, never its bytes.",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string", minLength: 1 },
                slug: {
                  type: "string",
                  pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$",
                  description: SLUG_DESCRIPTION,
                },
                icon: {
                  type: ["string", "null"],
                  maxLength: ICON_MAX_LENGTH,
                  description: `\`lucide:<name>\`, \`emoji:<one emoji>\`, or ${ICON_IMAGE_TYPES.map((type) => `\`data:${type};base64,…\``).join(" or ")} (at most ${ICON_IMAGE_MAX_BYTES} bytes and ${ICON_IMAGE_MAX_SIZE}×${ICON_IMAGE_MAX_SIZE} px); \`null\` clears it. ${EMOJI_ICON_WRITE_RULE}`,
                },
                color: {
                  type: ["string", "null"],
                  enum: [...APPEARANCE_COLORS, null],
                  description:
                    "A palette key; `null` clears it, the colour then derived from the organization id.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated organization — same OrgDetail shape as GET /api/orgs/{orgId}",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgDetail" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteOrganization",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Delete organization",
      description: "Delete organization and all associated data. Owner only.",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "204": {
          description: "Organization deleted",
          headers: STD_RESPONSE_HEADERS,
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/orgs/{orgId}/members": {
    post: {
      operationId: "inviteMember",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Invite a member",
      description:
        "Create a pending invitation for the given email (new and existing users alike). The invitee joins by opening the invite link, authenticating through the standard login/signup flow, then explicitly accepting. When SMTP is configured an invitation email is sent; otherwise the admin shares the returned token out of band.",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              // `role` carries a server-side default, so it is optional on the
              // wire — listing it required contradicted the `default` beside it.
              required: ["email"],
              properties: {
                email: { type: "string", format: "email" },
                role: { type: "string", enum: [...ASSIGNABLE_ORG_ROLES], default: "member" },
                space_assignments: SPACE_ASSIGNMENTS_BODY,
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description:
            "Invitation created — bare OrgInvitationInfo (same shape as the items in the invitations list in GET /api/orgs/{orgId}).",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgInvitationInfo" },
              example: {
                id: "inv_abc123",
                email: "newuser@example.com",
                role: "member",
                space_assignments: [{ spaceId: "spc_...", preset_role: "operator" }],
                token: "inv_abc123def456",
                expiresAt: "2026-02-01T00:00:00Z",
                createdAt: "2026-01-25T00:00:00Z",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "Conflict — this email already holds a pending invitation in the organization. `invitation_id` names it; edit it (PATCH /api/orgs/{orgId}/invitations/{invitationId}) to change the role or add a space instead of creating a second token.",
          content: {
            "application/problem+json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ProblemDetail" },
                  {
                    type: "object",
                    required: ["invitation_id"],
                    properties: {
                      invitation_id: {
                        type: "string",
                        description: "The pending invitation already held by this email.",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/orgs/{orgId}/members/{userId}": {
    put: {
      operationId: "changeMemberRole",
      "x-appstrate-space": { kind: "aggregate" },
      tags: ["Organizations"],
      summary: "Change member role",
      description:
        "Change a member's role. Owners can manage every other member, owners included, and are the only ones who may assign `owner` or change an owner's role; admins can manage guests and members and assign `guest`, `member` or `admin`. Nobody changes their own role. The caller is judged on their current role in the organization. Granting `owner` or changing an owner's role requires a dashboard session — any token (API key, OAuth/MCP client, CLI) is refused with 403 even when its user is an owner. The member's own role in their personal space (`setMemberPersonalSpaceRole`) is dropped by a promotion to owner or admin (audited as `personalSpaceRoleCleared`) and kept otherwise.",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "userId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["role"],
              properties: {
                role: { type: "string", enum: [...ORG_ROLES] },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated member — same shape as the members list in GET /api/orgs/{orgId}",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgMember" },
              example: {
                userId: "usr_def456",
                displayName: "Bob",
                email: "bob@acme.com",
                role: "admin",
                joinedAt: "2026-01-12T10:00:00Z",
                spaces: [
                  {
                    id: "spc_default",
                    name: "Default",
                    source: "org_role",
                    role: { kind: "preset", key: "admin", name: "admin" },
                  },
                ],
                personal_space_role: null,
                personal_space_default_role: { kind: "preset", key: "admin", name: "admin" },
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
    delete: {
      operationId: "removeMember",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Remove a member",
      description:
        "Remove a member from the organization. Owners can remove every other member, owners included; admins can remove guests and members. Nobody removes themselves — use `leaveOrganization`. The caller is judged on their current role in the organization; removing an owner requires a dashboard session (any token — API key, OAuth/MCP client, CLI — is refused with 403). The member's explicit space roles and notifications in this organization are deleted, their schedules here disabled, their API keys here revoked, the OAuth tokens bound to this organization deleted, their MCP grants on the organization's endpoints (organization and spaces) ended, and their personal space enters the 30-day offboarding window. An MCP-bound JWT access token is refused from its next request; only a JWT of an org-level OAuth client stays valid until it expires, and the per-request membership check refuses it meanwhile. Other members' schedules naming a connection the member shared are disabled too (`connection_unshared`); `getMemberDepartureImpact` lists, before the removal, every team-space schedule it would stop.",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "userId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Member removed",
          headers: STD_RESPONSE_HEADERS,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/orgs/{orgId}/members/{userId}/personal-space-role": {
    put: {
      operationId: "setMemberPersonalSpaceRole",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Set a member's role in their personal space",
      description:
        "Give one member or guest their own role in their personal space, overriding the organization's `personal_space_role` default Body: exactly one of `preset_role` / `custom_role_id`; a `custom_role_id` must name a role of this organization (404 otherwise). A member holds the chosen role plus, short of `admin`, `agents:delete`, `skills:delete`, `integrations:delete` and `schedules:delete` there. A guest holds it capped to `operator` (the permissions the chosen role shares with `operator`, plus the deletes), whatever role is set. The personal space is provisioned if the member has none yet. Owners and admins always hold `admin` in their own personal space: targeting one is `409 redundant_space_role`. A change of the member's org role keeps the override, a guest's capped as above, except a promotion to owner or admin, which drops it. A dropped override is recorded in the `org.member_role_updated` audit entry (`personalSpaceRoleCleared`). Leaving or being removed drops it too; nothing restores a dropped override. A custom role named by an override cannot be deleted (`409 role_in_use`). Same guard as `changeMemberRole` (`members:change-role`).",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "userId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              description: "Exactly one of `preset_role` / `custom_role_id`.",
              allOf: [{ oneOf: [{ required: ["preset_role"] }, { required: ["custom_role_id"] }] }],
              properties: {
                preset_role: { type: "string", enum: [...SPACE_ROLE_PRESETS] },
                custom_role_id: { type: "string", pattern: SPACE_ROLE_ID_PATTERN },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated member — same shape as the members list in GET /api/orgs/{orgId}",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgMember" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "The target is an owner or admin, who always hold `admin` in their personal space (`redundant_space_role`)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
    delete: {
      operationId: "clearMemberPersonalSpaceRole",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Return a member to the organization default in their personal space",
      description:
        "Drop the member's own role in their personal space, so they hold the organization's `personal_space_role` again (for a guest, capped to `operator`). Idempotent: 204 whether or not an override was set. 404 when the user is not a member of the organization. Same guard as `changeMemberRole` (`members:change-role`).",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "userId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Override cleared, or there was none",
          headers: STD_RESPONSE_HEADERS,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/orgs/{orgId}/personal-space-role/impact": {
    get: {
      operationId: "getPersonalSpaceRoleImpact",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Preview what a personal-space default would stop",
      description:
        "What setting the organization's `personal_space_role` to `role` would stop, without writing anything. `schedules` counts the ENABLED schedules in live personal spaces whose actor is the space's owner, a member or guest who follows the default (no override of their own, see `setMemberPersonalSpaceRole`) and would hold, under `role`, a resolved role without `agents:run` (guest cap and delete floor applied, as the resolver applies them). Each such schedule disables itself at its next fire (`disabled_reason: actor_invalid`), and restoring the role does not re-enable it. `members` counts the distinct owners of those schedules. Owners and admins always hold `admin` in their own personal space and are never counted; a `role` that grants `agents:run` answers `{ schedules: 0, members: 0 }`. A snapshot, which a later change can make stale. It discloses only counts, to a caller who may already rewrite the setting: same guard as `updateOrgSettings` (`org:settings`).",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "role",
          in: "query",
          required: true,
          description:
            "The candidate default, as `updateOrgSettings` takes `personal_space_role`: a preset key or the id of one of this organization's custom space roles.",
          schema: {
            oneOf: [
              { type: "string", enum: [...SPACE_ROLE_PRESETS] },
              { type: "string", pattern: SPACE_ROLE_ID_PATTERN },
            ],
          },
        },
      ],
      responses: {
        "200": {
          description: "What the candidate default would stop",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["schedules", "members"],
                properties: {
                  schedules: {
                    type: "integer",
                    minimum: 0,
                    description:
                      "Enabled schedules that would disable themselves at their next fire.",
                  },
                  members: {
                    type: "integer",
                    minimum: 0,
                    description: "Distinct members and guests owning those schedules.",
                  },
                },
                additionalProperties: false,
              },
              example: { schedules: 3, members: 2 },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": {
          description: "`role` names a custom role id that is not a role of this organization",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/orgs/{orgId}/members/{userId}/departure-impact": {
    get: {
      operationId: "getMemberDepartureImpact",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Preview what removing a member stops",
      description:
        "The enabled schedules in TEAM spaces that `removeMember` would disable for this member, in one list whatever the cause: `actor_left_org` for a schedule the member is the actor of, `connection_unshared` for another actor's schedule whose `connection_overrides` name a connection the member shares into that space (the removal withdraws every share of the member's connections). Each item's `lost_integrations` lists the integrations whose named connection belongs to the departing member: reassigning the schedule to another member (`updateSchedule`) is not enough there, a replacement connection is needed too. Read with the same selectors the removal uses, without writing anything: a snapshot, which a later change can make stale before the removal runs. Schedules in personal spaces are left out — the departing member's personal space enters its 30-day offboarding window and an administrator cannot read a live one. A credential confined to spaces (a space-bound token, the chat's bearer) sees only the items in the spaces it may name. Known limit: a binding to the member's connection outside the schedule's own `connection_overrides` — an admin pin, an organization default, or a member pin of the departing member — is not listed, and is not disabled by the removal either (the schedule fails at resolution). Same guard and same per-target rule as `removeMember`: 404 when the user is not a member, 403 when the caller could not remove them (an admin previewing an owner, any token previewing an owner).",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "userId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Schedules the removal would stop, ordered by space name then schedule name",
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
                        "id",
                        "name",
                        "space",
                        "packageId",
                        "actor",
                        "cause",
                        "lost_integrations",
                      ],
                      properties: {
                        id: { type: "string", description: "Schedule id." },
                        name: { type: ["string", "null"] },
                        space: {
                          type: "object",
                          required: ["id", "name"],
                          properties: { id: { type: "string" }, name: { type: "string" } },
                        },
                        packageId: { type: "string", description: "The scheduled agent." },
                        actor: {
                          type: "object",
                          required: ["type", "id", "name"],
                          properties: {
                            type: { type: "string", enum: ["user", "end_user"] },
                            id: { type: "string" },
                            name: { type: ["string", "null"] },
                          },
                        },
                        cause: {
                          type: "string",
                          enum: ["actor_left_org", "connection_unshared"],
                          description: "The `disabled_reason` the removal would set.",
                        },
                        lost_integrations: {
                          type: "array",
                          items: { type: "string" },
                          description:
                            "Integrations whose connection named in `connection_overrides` belongs to the departing member.",
                        },
                      },
                    },
                  },
                  hasMore: {
                    type: "boolean",
                    description:
                      "Always false: the list is not paginated. A credential confined to spaces receives only the items of the spaces it may name (see the description).",
                  },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "sch_abc123",
                    name: "Daily digest",
                    space: { id: "spc_team", name: "Sales" },
                    packageId: "@acme/digest",
                    actor: { type: "user", id: "usr_def456", name: "Bob" },
                    cause: "actor_left_org",
                    lost_integrations: ["@acme/gmail"],
                  },
                ],
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
  "/api/orgs/{orgId}/leave": {
    post: {
      operationId: "leaveOrganization",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Leave an organization",
      description:
        "The caller leaves the organization. Any member may leave, whatever their role; the last owner is refused with `409 last_owner` and must first promote another member to owner, or delete the organization. The decision reads the caller's real membership, so an active `X-View-As` preview changes nothing. Leaving has the effects of a removal: the caller's explicit space roles and notifications in this organization are deleted, their schedules here disabled, their API keys here revoked, the OAuth tokens bound to this organization deleted, their MCP grants on the organization's endpoints (organization and spaces) ended, and their personal space enters the 30-day offboarding window (a re-invitation inside it gives the space back; revoked keys and deleted tokens stay gone). An MCP-bound JWT access token is refused from its next request; only a JWT of an org-level OAuth client stays valid until it expires, and the per-request membership check refuses it meanwhile. Leaving requires a dashboard session — any token (API key, OAuth/MCP client, CLI) is refused with 403, as is a caller who is not a member.",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "204": {
          description: "Left the organization",
          headers: STD_RESPONSE_HEADERS,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": {
          description:
            "The caller's membership disappeared between authentication and the exit (a concurrent removal or leave). A caller who is not a member at all gets 403.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "409": { $ref: "#/components/responses/LastOwner" },
      },
    },
  },
  "/api/orgs/{orgId}/invitations/{invitationId}": {
    patch: {
      operationId: "changeInvitationRole",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Change invitation role",
      description:
        "Change the role and/or the space assignments of a pending invitation. Admin or owner required. Merge semantics (RFC 7396): omitting `space_assignments` keeps the ones already stored, and the role rules are re-checked against them.",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "invitationId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["role"],
              properties: {
                role: { type: "string", enum: [...ASSIGNABLE_ORG_ROLES] },
                space_assignments: SPACE_ASSIGNMENTS_BODY,
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Updated invitation — same shape as the invitations list in GET /api/orgs/{orgId}",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgInvitationInfo" },
              example: {
                id: "inv_abc123",
                email: "carol@acme.com",
                role: "admin",
                space_assignments: [],
                token: "tok_xyz789",
                expiresAt: "2026-02-01T00:00:00Z",
                createdAt: "2026-01-25T00:00:00Z",
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
    delete: {
      operationId: "cancelInvitation",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Cancel an invitation",
      description: "Cancel a pending invitation.",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "invitationId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Invitation cancelled",
          headers: STD_RESPONSE_HEADERS,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/orgs/{orgId}/settings": {
    get: {
      operationId: "getOrgSettings",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Get organization settings",
      description: "Get organization settings (redirect domains, etc.).",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Organization settings",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgSettings" },
              example: {
                api_version: "2026-03-21",
                personal_model_credentials: true,
                personal_space_role: "admin",
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    patch: {
      operationId: "updateOrgSettings",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Organizations"],
      summary: "Update organization settings",
      description:
        "Update organization settings. Merge semantics (RFC 7396): an absent field is left unchanged, `null` clears a nullable one.",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        content: {
          "application/json": {
            // Spelled out rather than `$ref: OrgSettings`, and CLOSED:
            // `orgSettingsPatchSchema` (`services/organizations.ts`) is
            // `.strict()`, so an unknown key is a 400 and never a silently
            // dropped setting. The component stays open because the READ path
            // returns the stored JSONB verbatim — the members are shared, the
            // closure is not.
            schema: {
              type: "object",
              description: "Organization settings patch — only provided fields are updated.",
              properties: ORG_SETTINGS_PROPERTIES,
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Settings updated",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgSettings" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": {
          description:
            "`personal_space_role` names a custom role id that is not a role of this organization",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
} as const;
