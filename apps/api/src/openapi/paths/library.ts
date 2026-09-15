// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS } from "../headers.ts";

/**
 * Library — the map of PLACEMENTS, in its two shapes.
 *
 * `GET /api/library` is the organization map: every package visible to the org
 * (org-owned + system) grouped by type, each carrying one `placements` entry
 * per space it is placed in and the caller reads.
 * `GET /api/spaces/{spaceId}/library` is one space's view of the same, its
 * placements narrowed to that space and its rows widened to what the caller
 * could still put there in one click.
 *
 * There is no `shared` section in either: an offer nobody has taken up is a
 * placement with `state: "none"`, on the package's own row and behind the same
 * switch as every other space — one act, one control.
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
      placements: [
        {
          space_id: "spc_3e6f8a1b-2c4d-4e70-8f92-a1b3c5d7e9f0",
          via: "home",
          state: "active",
          shared_by: null,
        },
        {
          space_id: "spc_7f0a2c4e-6b81-4d3f-9e57-c2a4b6d8e0f1",
          via: "shared",
          state: "none",
          shared_by: { user_id: "usr_1", name: "Alex" },
        },
      ],
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
      placements: [
        {
          space_id: "spc_3e6f8a1b-2c4d-4e70-8f92-a1b3c5d7e9f0",
          via: "system",
          state: "active",
          shared_by: null,
        },
        {
          space_id: "spc_7f0a2c4e-6b81-4d3f-9e57-c2a4b6d8e0f1",
          via: "system",
          state: "inactive",
          shared_by: null,
        },
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
      summary: "Organization library — the placement map (owners and admins)",
      description:
        "Returns every package the organization can see (org-owned + system), grouped by type, each carrying its " +
        "`placements`: one entry per space the package is placed in and the caller reads, saying WHY it is there " +
        "(`via`: home, shared, system) and whether that space runs it (`state`: active, inactive, none). " +
        "Organization owners and admins also see organization-catalogue packages (`home_space_id: null`) placed " +
        "nowhere, with their read permissions. Members, guests and API keys cannot access this administrative " +
        "endpoint. Ephemeral packages are excluded. The spaces list and the placements include only spaces the " +
        "caller can enter, and each package type also requires that type's read permission in the space. " +
        "Acting on the map is the same pair of doors as anywhere else: `POST /api/spaces/{spaceId}/packages` " +
        "activates a package in a space — creating the offer that places it when the caller holds `<type>:share` " +
        "in its home — and `DELETE /api/spaces/{spaceId}/packages/{scope}/{name}` deactivates it there.",
      parameters: [
        // `/api/library` is org-scoped, not space-scoped — no X-Space-Id.
        { $ref: "#/components/parameters/XOrgId" },
      ],
      responses: {
        "200": {
          description: "Organization placement map.",
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
      summary: "One space's placements, and what the caller could still place there",
      description:
        "Accessible to readers of the target space. Every row carries its `placements`, narrowed to this space: a package homed here, offered here, or shipped with the platform, with `state` saying whether the space runs it — `none` is exactly a pending offer, taken up with `POST /api/spaces/{spaceId}/packages` like any other activation. The rows also include what the caller could still PLACE here, so the listing never proposes a package that door would refuse: for a TEAM destination, a package whose home grants them the type's `share` permission (`home_shareable`, since activating then creates the offer) and the organization catalogue for an owner or admin; for a PERSONAL destination, nothing beyond what is already placed — an offer into somebody's own space is somebody else's act. Such a candidate carries an EMPTY `placements` array. Each package type requires read permission in the target space. Activation remains subject to the target space's permissions, waived in the caller's own personal space. Personal spaces remain private and API keys remain pinned to their space.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "spaceId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "This space's placement map, plus what the caller could still place here.",
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
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
