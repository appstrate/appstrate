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
      summary: "List all packages visible to the org with per-space install state",
      description:
        "Returns every package available to the caller's organization (org-owned + system) " +
        "grouped by type (`agent`, `skill`, `mcp-server`, `integration`). Each package carries an " +
        "`installed_in` array of space ids — the spaces belonging to the caller's " +
        "org where the package is currently installed. Ephemeral packages are excluded.\n\n" +
        "The response also includes the org's spaces (id, name, isDefault) so the UI " +
        "can render a single grid keyed by space without an additional `/api/spaces` call.",
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
                required: ["object", "spaces", "packages"],
                properties: {
                  object: { type: "string", enum: ["library"] },
                  spaces: {
                    type: "array",
                    description:
                      "Spaces belonging to the caller's organization. The default " +
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
                      installed_in: [
                        "spc_3e6f8a1b-2c4d-4e70-8f92-a1b3c5d7e9f0",
                        "spc_7f0a2c4e-6b81-4d3f-9e57-c2a4b6d8e0f1",
                      ],
                    },
                  ],
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
} as const;
