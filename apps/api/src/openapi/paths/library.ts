// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS } from "../headers.ts";

/**
 * Library — the package list, in its two shapes.
 *
 * `GET /api/library` is the organization CATALOGUE: every package visible to
 * the org (org-owned + system) grouped by type, each carrying `installed_in`.
 * `GET /api/spaces/{spaceId}/library` is one space's view of the same, narrowed
 * to what the caller could actually put there — and it is the ONLY one with a
 * `shared` section, because an offer is addressed to a space and taken up from
 * that space's page. The catalogue is an administrative map of what exists and
 * where it sits, not a recipient's inbox.
 */

/** The spaces the two listings project — identical in both shapes. */
const SPACES_SCHEMA = {
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
} as const;

/** The typed package matrix — identical in both shapes. */
const PACKAGES_SCHEMA = {
  type: "object",
  description: "Packages grouped by type. Every group is always present (possibly empty).",
  required: ["agent", "skill", "mcp-server", "integration"],
  properties: {
    agent: { $ref: "#/components/schemas/LibraryPackageList" },
    skill: { $ref: "#/components/schemas/LibraryPackageList" },
    "mcp-server": { $ref: "#/components/schemas/LibraryPackageList" },
    integration: { $ref: "#/components/schemas/LibraryPackageList" },
  },
} as const;

/** Shared example rows, so both listings show the same catalogue. */
const PACKAGES_EXAMPLE = {
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
    },
  ],
} as const;

const SPACES_EXAMPLE = [
  { id: "spc_3e6f8a1b-2c4d-4e70-8f92-a1b3c5d7e9f0", name: "Default", isDefault: true },
  { id: "spc_7f0a2c4e-6b81-4d3f-9e57-c2a4b6d8e0f1", name: "Staging", isDefault: false },
] as const;

const organizationLibraryPaths = {
  "/api/library": {
    get: {
      operationId: "getLibrary",
      tags: ["Library"],
      summary: "Organization library (owners and admins)",
      description:
        "Returns packages readable in an accessible space, plus readable system packages, grouped by type. " +
        "Organization owners and admins also see uninstalled organization packages with their read permissions. " +
        "Members, guests and API keys cannot access this administrative endpoint. Ephemeral packages are excluded. " +
        "The spaces list and installed_in mappings include only spaces the caller can enter, and package mappings " +
        "also require the package type's read permission in that space. " +
        "This is the catalogue, not an inbox: it carries NO `shared` section — an offer is addressed to a space, " +
        "and `GET /api/spaces/{spaceId}/library` is where it is presented and taken up.",
      parameters: [
        // `/api/library` is org-scoped, not space-scoped — no X-Space-Id.
        { $ref: "#/components/parameters/XOrgId" },
      ],
      responses: {
        "200": {
          description: "Organization catalogue snapshot. Carries no `shared` section.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "spaces", "packages"],
                properties: {
                  object: { type: "string", enum: ["library"] },
                  spaces: SPACES_SCHEMA,
                  packages: PACKAGES_SCHEMA,
                },
              },
              example: {
                object: "library",
                spaces: SPACES_EXAMPLE,
                packages: PACKAGES_EXAMPLE,
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

export const libraryPaths = {
  ...organizationLibraryPaths,
  "/api/spaces/{spaceId}/library": {
    get: {
      operationId: "getSpaceLibrary",
      tags: ["Library"],
      summary: "Discover packages and pending shares for a space",
      description:
        "Accessible to readers of the target space. The candidates are exactly what the caller could put there, so the listing never offers a package the install would refuse. For a TEAM destination: packages already PLACED in it (homed there or shared with it), plus packages the caller may place there — those whose home space grants them the type's `share` permission (`home_shareable`), since installing then creates the offer — plus the organization catalogue for an owner or admin, plus system packages. For a PERSONAL destination: placed packages only, plus system packages other than integrations — an offer into somebody's own space is somebody else's act, and arrives in `shared`. Each package type requires read permission in the target space. Installation remains subject to the target space permissions. Personal spaces remain private and API keys remain pinned to their space.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "spaceId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Space library snapshot: the matrix, plus the offers awaiting a decision.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "spaces", "packages", "shared"],
                properties: {
                  object: { type: "string", enum: ["library"] },
                  spaces: SPACES_SCHEMA,
                  packages: PACKAGES_SCHEMA,
                  shared: {
                    type: "array",
                    description:
                      'Packages OFFERED to this space and not installed in it — "shared with me", i.e. the offers still waiting on a decision, and their ONLY place in this response: a package whose sole placement here is an untaken offer is deliberately absent from `packages`, so one act is never behind two buttons. Installing it (`POST /api/spaces/{spaceId}/packages`) moves it out of this list and into `packages` with an `installed_in` entry. Empty when nobody has offered anything.',
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
                            "The offered space is the caller's OWN personal space. Either way the offer is taken up with `POST /api/spaces/{spaceId}/packages` on `space_id` — there is no separate accept route; in a personal space the owner needs no install grant, in a team space the caller does.",
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
                spaces: SPACES_EXAMPLE,
                packages: PACKAGES_EXAMPLE,
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
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
