// SPDX-License-Identifier: Apache-2.0

import { SPACE_ROLE_PRESETS, SPACE_VISIBILITIES } from "@appstrate/core/permissions";
import { STD_RESPONSE_HEADERS, REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

export const spacesPaths = {
  "/api/spaces": {
    post: {
      operationId: "createSpace",
      tags: ["Spaces"],
      summary: "Create a space",
      description:
        "Create a new space for the organization. Spaces scope end-users and their sessions.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: {
                  type: "string",
                  minLength: 1,
                  maxLength: 100,
                  description: "Human-readable space name",
                },
                settings: {
                  type: "object",
                  properties: {
                    allowedRedirectDomains: {
                      type: "array",
                      items: { type: "string" },
                      maxItems: 20,
                      description:
                        "Allowed OAuth redirect domains (e.g. myapp.com, staging.myapp.com). Subdomains are matched automatically.",
                    },
                  },
                  description: "Space settings",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Space created",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SpaceObject" },
              example: {
                id: "spc_5b8c0e13-4f7a-4d92-b3c6-71e0a4d9f582",
                object: "space",
                orgId: "550e8400-e29b-41d4-a716-446655440000",
                name: "My SaaS App",
                isDefault: false,
                settings: {
                  allowedRedirectDomains: ["myapp.com", "staging.myapp.com"],
                },
                visibility: "open",
                default_role: "operator",
                access: "member",
                role: { kind: "preset", key: "admin", name: "admin" },
                permissions: ["agents:read", "agents:run"],
                created_by: "usr_k7x9m2p4q1",
                createdAt: "2026-01-15T10:30:00Z",
                updatedAt: "2026-01-15T10:30:00Z",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    get: {
      operationId: "listSpaces",
      tags: ["Spaces"],
      summary: "List spaces",
      description: "List all spaces for the organization.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Space list",
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
                    items: { $ref: "#/components/schemas/SpaceObject" },
                  },
                  hasMore: {
                    type: "boolean",
                    description: "Whether more results exist beyond this page",
                  },
                },
              },
              example: {
                object: "list",
                data: [
                  {
                    id: "spc_0a2b4c6d-8e10-4f32-9a54-b6c8d0e2f416",
                    object: "space",
                    orgId: "550e8400-e29b-41d4-a716-446655440000",
                    name: "Default",
                    isDefault: true,
                    settings: { allowedRedirectDomains: [] },
                    visibility: "open",
                    default_role: "operator",
                    access: "member",
                    role: { kind: "preset", key: "operator", name: "operator" },
                    permissions: ["agents:read", "agents:run"],
                    created_by: null,
                    createdAt: "2026-01-10T08:00:00Z",
                    updatedAt: "2026-01-10T08:00:00Z",
                  },
                  {
                    id: "spc_5b8c0e13-4f7a-4d92-b3c6-71e0a4d9f582",
                    object: "space",
                    orgId: "550e8400-e29b-41d4-a716-446655440000",
                    name: "My SaaS App",
                    isDefault: false,
                    settings: { allowedRedirectDomains: ["myapp.com"] },
                    visibility: "closed",
                    default_role: "operator",
                    access: "none",
                    role: null,
                    permissions: ["org:read", "spaces:read"],
                    created_by: "usr_k7x9m2p4q1",
                    createdAt: "2026-01-15T10:30:00Z",
                    updatedAt: "2026-01-15T10:30:00Z",
                  },
                ],
                hasMore: false,
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/spaces/{id}": {
    get: {
      operationId: "getSpace",
      tags: ["Spaces"],
      summary: "Get a space",
      description: "Get a single space by ID.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Space detail",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SpaceObject" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    patch: {
      operationId: "updateSpace",
      tags: ["Spaces"],
      summary: "Update a space",
      description:
        "Update space name, settings, visibility or default role. Requires `space-settings:write` in THIS space (preset `admin`), not the org-level `spaces:write`. Changing the default role or opening a space requires the caller to hold every permission of the resulting default role (403 otherwise). Making the org's default space non-`open` is a 400.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  minLength: 1,
                  maxLength: 100,
                  description: "Human-readable space name",
                },
                settings: {
                  type: "object",
                  properties: {
                    allowedRedirectDomains: {
                      type: "array",
                      items: { type: "string" },
                      maxItems: 20,
                      description:
                        "Allowed OAuth redirect domains (e.g. myapp.com, staging.myapp.com). Subdomains are matched automatically.",
                    },
                  },
                  description: "Space settings",
                },
                visibility: {
                  type: "string",
                  enum: [...SPACE_VISIBILITIES],
                  description:
                    "Who reaches the space without an explicit membership row. The default space must stay `open`.",
                },
                default_role: {
                  type: "string",
                  enum: [...SPACE_ROLE_PRESETS],
                  description: "Preset the implicit members of an `open` space hold",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Space updated",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SpaceObject" },
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
      operationId: "deleteSpace",
      tags: ["Spaces"],
      summary: "Delete a space",
      description:
        "Delete a space and all associated end-users. The default space cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Space deleted",
          headers: REQUEST_ID_ONLY_HEADERS,
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/spaces/{spaceId}/packages": {
    get: {
      operationId: "listInstalledPackages",
      tags: ["Space Packages"],
      summary: "List installed packages",
      description:
        "List all packages installed in this space, with their model/proxy/version overrides.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "spaceId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "type",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["agent", "skill", "mcp-server", "integration"] },
          description: "Filter by package type",
        },
      ],
      responses: {
        "200": {
          description: "Installed packages list",
          headers: REQUEST_ID_ONLY_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/SpacePackage" },
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
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "installPackage",
      tags: ["Space Packages"],
      summary: "Install a package",
      description: "Install a package from the organization catalog into this space.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "spaceId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["packageId"],
              properties: {
                packageId: {
                  type: "string",
                  minLength: 1,
                  description: "Package ID from org catalog",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Package installed",
          headers: REQUEST_ID_ONLY_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SpacePackage" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Package already installed in this space",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/spaces/{spaceId}/packages/{scope}/{name}": {
    get: {
      operationId: "getInstalledPackage",
      tags: ["Space Packages"],
      summary: "Get installed package",
      description: "Get an installed package detail with its model/proxy/version overrides.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "spaceId", in: "path", required: true, schema: { type: "string" } },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Installed package detail",
          headers: REQUEST_ID_ONLY_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SpacePackage" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateInstalledPackage",
      tags: ["Space Packages"],
      summary: "Update installed package overrides",
      description:
        "Update the model/proxy overrides, generation settings, enabled flag, or version pinning for an installed package. The agent's stored input values are NOT settable here — use `PUT /api/agents/{scope}/{name}/input-settings`, which validates them against the manifest input schema.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "spaceId", in: "path", required: true, schema: { type: "string" } },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                generationConfig: {
                  oneOf: [
                    { $ref: "#/components/schemas/ModelGenerationSettings" },
                    { type: "null" },
                  ],
                },
                modelId: { type: ["string", "null"] },
                proxyId: { type: ["string", "null"] },
                version_id: { type: ["integer", "null"] },
                enabled: { type: "boolean" },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated installed package",
          headers: REQUEST_ID_ONLY_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SpacePackage" },
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
      operationId: "uninstallPackage",
      tags: ["Space Packages"],
      summary: "Uninstall a package",
      description: "Remove a package from this space.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "spaceId", in: "path", required: true, schema: { type: "string" } },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "204": { description: "Package uninstalled" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/spaces/{spaceId}/packages/{scope}/{name}/run-config": {
    get: {
      operationId: "getSpacePackageRunConfig",
      tags: ["Space Packages"],
      summary: "Get the resolved per-space run configuration",
      description:
        "Returns the configuration applied when this space runs the given package: model override, generation settings, proxy override, pinned version label, and the stored input layer (editor values plus locked fields). Used by the CLI to reproduce a UI run without stitching together three separate calls; the UI uses the same source for its run-from-space flow.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "spaceId", in: "path", required: true, schema: { type: "string" } },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Resolved run configuration",
          headers: REQUEST_ID_ONLY_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["generation", "modelId", "proxyId", "version_pin", "input"],
                properties: {
                  generation: {
                    oneOf: [
                      { $ref: "#/components/schemas/ModelGenerationSettings" },
                      { type: "null" },
                    ],
                  },
                  modelId: { type: ["string", "null"] },
                  proxyId: { type: ["string", "null"] },
                  version_pin: { type: ["string", "null"] },
                  input: {
                    type: "object",
                    allOf: [{ $ref: "#/components/schemas/AgentInputSettings" }],
                    description:
                      "Stored input layer for this space — the editor's values and the fields it locked. A locally executed run applies `values` under the caller's input and refuses a caller value naming a locked field.",
                  },
                },
              },
              example: {
                generation: { temperature: 0.2, reasoningLevel: "high" },
                modelId: "claude-sonnet-4-6",
                proxyId: null,
                version_pin: "1.2.3",
                input: { values: { dry_run: true }, locked_fields: ["dry_run"] },
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
  "/api/spaces/{id}/roles": {
    get: {
      operationId: "listAssignableSpaceRoles",
      tags: ["Spaces"],
      summary: "List assignable space roles",
      description:
        "Returns presets and organization roles whose permissions are held by the caller in this space. Requires space-members:invite, space-members:change-role, or space-settings:write.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Assignable space roles",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: { $ref: "#/components/schemas/RoleObject" } },
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

  "/api/spaces/{id}/members": {
    get: {
      operationId: "listSpaceMembers",
      tags: ["Spaces"],
      summary: "List space members",
      description:
        'Everyone who actually reaches the space, not just everyone who was added: explicit rows, org owners/admins (`source: "org_role"`) and — in an `open` space — every org member (`source: "open_space"`).',
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Space member list",
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
                    items: { $ref: "#/components/schemas/SpaceMemberObject" },
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
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "addSpaceMember",
      tags: ["Spaces"],
      summary: "Add a space member",
      description:
        "Grant a user an explicit role in this space, limited to permissions held by the caller. Identify the user by exactly one of userId or email (trimmed and case-normalized). The user must already be an org member (404 otherwise). An existing explicit row is refused with 409 `space_member_exists`; use PATCH to change its role. Owners and admins are refused with 409 `redundant_space_role` — they already run every space.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              allOf: [{ oneOf: [{ required: ["userId"] }, { required: ["email"] }] }],
              properties: {
                userId: { type: "string", minLength: 1 },
                email: { type: "string", format: "email" },
                preset_role: { type: "string", enum: [...SPACE_ROLE_PRESETS] },
                custom_role_id: { type: "string", minLength: 1 },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Space member added",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SpaceMemberAssignment" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "The target is an owner/admin (`redundant_space_role`) or already has an explicit role (`space_member_exists`)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },

  "/api/spaces/{id}/members/{userId}": {
    patch: {
      operationId: "updateSpaceMember",
      tags: ["Spaces"],
      summary: "Change a space member's role",
      description:
        "Change the role of an EXISTING explicit membership row (404 when there is none). The new role may only grant permissions held by the caller, including when changing their own role.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "userId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                preset_role: { type: "string", enum: [...SPACE_ROLE_PRESETS] },
                custom_role_id: { type: "string", minLength: 1 },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Space member role changed",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SpaceMemberAssignment" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "The target is an owner or admin — an explicit space role would grant nothing",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
    delete: {
      operationId: "removeSpaceMember",
      tags: ["Spaces"],
      summary: "Remove a space member",
      description:
        "Drop the explicit role. `access_after` says whether the member keeps implicit access (an `open` space) or loses the space entirely. Refused with 403 if removing the row would grant implicit permissions the caller does not hold.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "userId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Space member removed",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SpaceMemberRemoval" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
