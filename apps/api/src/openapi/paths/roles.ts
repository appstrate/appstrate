// SPDX-License-Identifier: Apache-2.0

import { ORG_ROLES, SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import { STD_RESPONSE_HEADERS, REQUEST_ID_ONLY_HEADERS } from "../headers.ts";
import { SPACE_ROLE_ID_PATTERN } from "../schemas.ts";

const ROLE_ID_PARAM = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", pattern: SPACE_ROLE_ID_PATTERN },
  description: "Custom role id (`srl_` prefix). Presets are not addressable.",
} as const;

export const rolesPaths = {
  "/api/org-roles": {
    get: {
      operationId: "listOrgRoles",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Roles"],
      summary: "List organization roles",
      description:
        'The four organization roles (`owner`, `admin`, `member`, `guest`) and the org-level permissions each grants — the platform\'s own matrix with what the loaded modules contribute at `level: "org"`. The same in every organization and for every caller (no preview, no credential ceiling): it describes the roles, not the caller. Membership is checked in the organization selected by X-Org-Id. Any member may read it.',
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Organization roles",
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
                      required: ["object", "role", "permissions"],
                      properties: {
                        object: { type: "string", enum: ["org_role"] },
                        role: { type: "string", enum: [...ORG_ROLES] },
                        permissions: {
                          type: "array",
                          items: { type: "string" },
                          description: "Org-level permissions the role grants, sorted.",
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
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/roles": {
    get: {
      operationId: "listRoles",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Roles"],
      summary: "List space roles",
      description:
        'Every role assignable in a space of this organization: the platform presets (`kind: "preset"`, read-only, `id: null`) followed by the organization\'s own bundles (`kind: "custom"`).',
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Role list",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: { $ref: "#/components/schemas/RoleObject" } },
                  hasMore: {
                    type: "boolean",
                    description: "Whether more results exist beyond this page",
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
    post: {
      operationId: "createRole",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Roles"],
      summary: "Create a custom space role",
      description:
        "Define an organization-scoped bundle of space-level permissions. Requires `roles:write` (owner/admin) and nothing else — custom roles ship with the open-source platform. Every permission is validated against `GET /api/roles/vocabulary`; an unknown string is a 400 naming it, never a silent drop. The set must also be coherent: a permission whose vocabulary entry has a non-empty `requires_one_of` comes with one of those reads, and a set missing one is a 400 naming each missing read. `requires_one_of` is the authority on which permissions need a read and which reads satisfy it. The read is never added for you.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["key", "name", "permissions"],
              properties: {
                key: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9-]{0,63}$",
                  description:
                    "Slug, unique per organization. Never one of the preset keys " +
                    `(${SPACE_ROLE_PRESETS.map((preset) => `\`${preset}\``).join(", ")}).`,
                },
                name: { type: "string", minLength: 1, maxLength: 100 },
                description: { type: ["string", "null"], maxLength: 500 },
                permissions: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  description: "Space-level permission strings the role grants (at least one).",
                },
                shows_studio: {
                  type: "boolean",
                  default: true,
                  description:
                    "Whether holders see the Studio's screens in the interface. Default `true`. A display attribute, not a permission and not a boundary: the API answers the role's permissions either way.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Role created",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RoleObject" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description: "A role with this key already exists (`role_key_taken`)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },

  "/api/roles/vocabulary": {
    get: {
      operationId: "listRoleVocabulary",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Roles"],
      summary: "List the permissions a custom role may hold",
      description:
        "The space-level permission strings a custom role can be built from, grouped by resource. `api_key_grantable` mirrors `GET /api/api-keys/available-scopes`; `requires_one_of` names the reads a role holding the permission must also hold. Whether a role shows the Studio is not a permission: it is the role's `shows_studio`.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Space-level permission vocabulary",
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
                    items: { $ref: "#/components/schemas/RoleVocabularyGroup" },
                  },
                  hasMore: {
                    type: "boolean",
                    description: "Whether more results exist beyond this page",
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

  "/api/roles/{id}": {
    patch: {
      operationId: "updateRole",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Roles"],
      summary: "Update a custom space role",
      description:
        "Rename, re-describe or re-scope a bundle. Requires `roles:write`. The `srl_` id never changes, so assignments follow the edit. A `permissions` array is validated as on create: an unknown string is a 400 naming it, and a set holding a permission without one of the reads its vocabulary entry's `requires_one_of` names is a 400 naming each missing read. A request without `permissions` is not re-judged. `shows_studio` alone changes whether holders see the Studio.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }, ROLE_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                key: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
                name: { type: "string", minLength: 1, maxLength: 100 },
                description: { type: ["string", "null"], maxLength: 500 },
                permissions: { type: "array", items: { type: "string", minLength: 1 } },
                shows_studio: {
                  type: "boolean",
                  description:
                    "Whether holders see the Studio's screens in the interface. Absent = unchanged.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Role updated",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RoleObject" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "A role with this key already exists (`role_key_taken`)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
    delete: {
      operationId: "deleteRole",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Roles"],
      summary: "Delete a custom space role",
      description:
        "Remove a bundle. Requires `roles:delete` (owner/admin). Refused with 409 `role_in_use` while any space member holds the role (a member's own override in their personal space included), any PENDING invitation assigns it, an OIDC client's sign-up policy (`signup_space_assignments`) assigns it, or the organization's `personal_space_role` setting names it — the problem body carries `member_count`, `pending_invitation_count`, `signup_assignment_count` and `org_default`. Reassign them, edit the sign-up policies, or change that setting, first.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }, ROLE_ID_PARAM],
      responses: {
        "204": { description: "Role deleted", headers: REQUEST_ID_ONLY_HEADERS },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "The role is still assigned (`role_in_use`)",
          content: {
            "application/problem+json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/ProblemDetail" },
                  {
                    type: "object",
                    required: [
                      "member_count",
                      "pending_invitation_count",
                      "signup_assignment_count",
                      "org_default",
                    ],
                    properties: {
                      member_count: {
                        type: "integer",
                        description: "Space members still holding this role.",
                      },
                      pending_invitation_count: {
                        type: "integer",
                        description:
                          "Pending invitations whose `space_assignments` name this role.",
                      },
                      signup_assignment_count: {
                        type: "integer",
                        description:
                          "The organization's OIDC clients whose `signup_space_assignments` assign this role.",
                      },
                      org_default: {
                        type: "boolean",
                        description:
                          "Whether the organization's `personal_space_role` setting names this role.",
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
} as const;
