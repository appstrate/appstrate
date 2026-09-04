// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS, REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

const ROLE_ID_PARAM = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^srl_" },
  description: "Custom role id (`srl_` prefix). Presets are not addressable.",
} as const;

/**
 * The 403 of a write route, which has TWO causes and one status: the caller
 * lacks the permission (`forbidden`), or the deployment does not carry the
 * feature (`feature_unavailable`). `code` is what tells them apart, so both are
 * named here rather than the generic `Forbidden` response, which documents only
 * the first.
 */
const WRITE_FORBIDDEN = {
  description:
    "`forbidden` — the caller does not hold the required `roles:*` permission; or `feature_unavailable` — `custom_roles` is not available on this deployment (the four built-in presets stay usable).",
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/ProblemDetail" },
      examples: {
        forbidden: {
          summary: "Missing permission",
          value: {
            type: "https://docs.appstrate.dev/errors/forbidden",
            title: "Forbidden",
            status: 403,
            detail: "Insufficient permissions: roles:write required",
            instance: "urn:appstrate:request:req_2f1c6d84",
            code: "forbidden",
            requestId: "req_2f1c6d84",
          },
        },
        feature_unavailable: {
          summary: "Feature not on this deployment",
          value: {
            type: "https://docs.appstrate.dev/errors/feature-unavailable",
            title: "Feature Unavailable",
            status: 403,
            detail:
              "Defining custom space roles requires the `custom_roles` feature, provided by the Appstrate Cloud plan (the `@appstrate/cloud` module).",
            instance: "urn:appstrate:request:req_2f1c6d84",
            code: "feature_unavailable",
            requestId: "req_2f1c6d84",
          },
        },
      },
    },
  },
} as const;

export const rolesPaths = {
  "/api/roles": {
    get: {
      operationId: "listRoles",
      tags: ["Roles"],
      summary: "List space roles",
      description:
        'Every role assignable in a space of this organization: the four platform presets (`kind: "preset"`, read-only, `id: null`) followed by the organization\'s own bundles (`kind: "custom"`).',
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
      tags: ["Roles"],
      summary: "Create a custom space role",
      description:
        "Define an organization-scoped bundle of space-level permissions. Requires the `custom_roles` feature. Every permission is validated against `GET /api/roles/vocabulary`; an unknown string is a 400 naming it, never a silent drop.",
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
                    "Slug, unique per organization. Never one of the preset keys (`admin`, `builder`, `operator`, `viewer`).",
                },
                name: { type: "string", minLength: 1, maxLength: 100 },
                description: { type: ["string", "null"], maxLength: 500 },
                permissions: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  description: "Space-level permission strings the role grants (at least one).",
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
        "403": WRITE_FORBIDDEN,
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
      tags: ["Roles"],
      summary: "List the permissions a custom role may hold",
      description:
        "The space-level permission strings a custom role can be built from, grouped by resource. `api_key_grantable` mirrors `GET /api/api-keys/available-scopes`; `end_user_grantable` reports the strings a loaded module opted in for end-user OIDC tokens.",
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
      tags: ["Roles"],
      summary: "Update a custom space role",
      description:
        "Rename, re-describe or re-scope a bundle. Requires the `custom_roles` feature. The `srl_` id never changes, so assignments follow the edit.",
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
        "403": WRITE_FORBIDDEN,
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
      tags: ["Roles"],
      summary: "Delete a custom space role",
      description:
        "Requires the `custom_roles` feature. Refused with 409 `role_in_use` while any space member holds the role or any PENDING invitation assigns it — the problem body carries `member_count` and `pending_invitation_count`. Reassign them first.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }, ROLE_ID_PARAM],
      responses: {
        "204": { description: "Role deleted", headers: REQUEST_ID_ONLY_HEADERS },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": WRITE_FORBIDDEN,
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
                    required: ["member_count", "pending_invitation_count"],
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
