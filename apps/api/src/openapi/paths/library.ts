// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS } from "../headers.ts";

/**
 * Library — consolidated package list across the org's spaces.
 *
 * Single endpoint that powers the dashboard library view: returns every
 * package visible to the org (org-owned + system) grouped by type, with
 * a per-package `installed_in` array indicating which of the caller's
 * spaces already have the package installed.
 */

export const libraryPaths = {
  "/api/library": {
    get: {
      operationId: "getLibrary",
      tags: ["Library"],
      summary: "List readable packages with accessible-space install state",
      description:
        "Returns packages readable in an accessible space, plus readable system packages, grouped by type. " +
        "Organization owners and admins also see uninstalled organization packages with their read permissions. " +
        "Space-pinned API keys see only their own space and its packages. Ephemeral packages are excluded. " +
        "The spaces list and installed_in mappings include only spaces the caller can enter, and package mappings " +
        "also require the package type's read permission in that space.",
      parameters: [
        // `/api/library` is org-scoped, not space-scoped — no X-Space-Id.
        { $ref: "#/components/parameters/XOrgId" },
      ],
      responses: {
        "200": {
          description: "Library snapshot.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "spaces", "packages", "shared"],
                properties: {
                  object: { type: "string", enum: ["library"] },
                  spaces: {
                    type: "array",
                    description:
                      "Accessible spaces in the caller's organization, restricted to an API key's space. The default " +
                      "space (if any) is listed first.",
                    items: {
                      type: "object",
                      required: ["id", "name", "isDefault"],
                      properties: {
                        id: { type: "string", description: "Space id (`spc_…`)." },
                        name: { type: "string" },
                        isDefault: { type: "boolean" },
                      },
                    },
                  },
                  packages: {
                    type: "object",
                    description:
                      "Packages grouped by type. Every group is always present (possibly empty).",
                    required: ["agent", "skill", "mcp-server", "integration"],
                    properties: {
                      agent: { $ref: "#/components/schemas/LibraryPackageList" },
                      skill: { $ref: "#/components/schemas/LibraryPackageList" },
                      "mcp-server": { $ref: "#/components/schemas/LibraryPackageList" },
                      integration: { $ref: "#/components/schemas/LibraryPackageList" },
                    },
                  },
                  shared: {
                    type: "array",
                    description:
                      'Packages OFFERED to a space the caller reads and not installed there — "shared with me", i.e. the offers still waiting on a decision. An accepted offer leaves this list and appears as an installation in `packages`. Empty for a caller nobody has shared anything with.',
                    items: {
                      type: "object",
                      required: [
                        "id",
                        "type",
                        "source",
                        "name",
                        "description",
                        "space_id",
                        "personal",
                        "shared_by",
                      ],
                      properties: {
                        id: { type: "string", description: "Package id (`@scope/name`)." },
                        type: {
                          type: "string",
                          enum: ["agent", "skill", "mcp-server", "integration"],
                        },
                        source: { type: "string" },
                        name: { type: "string" },
                        description: { type: "string" },
                        space_id: {
                          type: "string",
                          description:
                            "The space the package is offered to (`spc_…`) — always one the caller reads, so no private id is disclosed.",
                        },
                        personal: {
                          type: "boolean",
                          description:
                            "The offered space is the caller's OWN personal space, i.e. `POST /api/packages/{scope}/{name}/shares/accept` applies. When false the offer targets a team space and is installed through `POST /api/spaces/{spaceId}/packages` by someone holding the type's install grant there.",
                        },
                        shared_by: {
                          type: ["object", "null"],
                          description: "Who shared it. `null` once that account is gone.",
                          required: ["user_id", "name"],
                          properties: {
                            user_id: { type: "string" },
                            name: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
              example: {
                object: "library",
                spaces: [
                  {
                    id: "spc_3e6f8a1b-2c4d-4e70-8f92-a1b3c5d7e9f0",
                    name: "Default",
                    isDefault: true,
                  },
                  {
                    id: "spc_7f0a2c4e-6b81-4d3f-9e57-c2a4b6d8e0f1",
                    name: "Staging",
                    isDefault: false,
                  },
                ],
                packages: {
                  agent: [
                    {
                      id: "pkg_inbox_triage",
                      type: "agent",
                      source: "local",
                      name: "Inbox Triage",
                      description: "Sorts incoming Gmail threads into priority buckets.",
                      home_space_id: "spc_3e6f8a1b-2c4d-4e70-8f92-a1b3c5d7e9f0",
                      home_writable: true,
                      home_shareable: true,
                      installed_in: ["spc_3e6f8a1b-2c4d-4e70-8f92-a1b3c5d7e9f0"],
                      update_available: false,
                    },
                  ],
                  skill: [],
                  "mcp-server": [],
                  integration: [
                    {
                      id: "pkg_gmail",
                      type: "integration",
                      source: "system",
                      name: "Gmail",
                      description: "Google Mail OAuth integration.",
                      home_space_id: null,
                      home_writable: false,
                      home_shareable: false,
                      installed_in: [
                        "spc_3e6f8a1b-2c4d-4e70-8f92-a1b3c5d7e9f0",
                        "spc_7f0a2c4e-6b81-4d3f-9e57-c2a4b6d8e0f1",
                      ],
                      update_available: false,
                    },
                  ],
                },
                shared: [
                  {
                    id: "@acme/weekly-digest",
                    type: "agent",
                    source: "local",
                    name: "Weekly Digest",
                    description: "Summarises the week's threads.",
                    space_id: "spc_9a1b3c5d-7e9f-4a1b-8c3d-5e7f9a1b3c5d",
                    personal: true,
                    shared_by: { user_id: "usr_1", name: "Alex" },
                  },
                ],
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
