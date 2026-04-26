// SPDX-License-Identifier: Apache-2.0

/**
 * Library — consolidated package list across the org's applications.
 *
 * Single endpoint that powers the dashboard library view: returns every
 * package visible to the org (org-owned + system) grouped by type, with
 * a per-package `installedIn` array indicating which of the caller's
 * applications already have the package installed.
 */

export const libraryPaths = {
  "/api/library": {
    get: {
      operationId: "getLibrary",
      tags: ["Library"],
      summary: "List all packages visible to the org with per-app install state",
      description:
        "Returns every package available to the caller's organization (org-owned + system) " +
        "grouped by type (`agent`, `skill`, `tool`, `provider`). Each package carries an " +
        "`installedIn` array of application ids — the applications belonging to the caller's " +
        "org where the package is currently installed. Ephemeral packages are excluded.\n\n" +
        "The response also includes the org's applications (id, name, isDefault) so the UI " +
        "can render a single grid keyed by app without an additional `/api/applications` call.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      responses: {
        "200": {
          description: "Library snapshot.",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "applications", "packages"],
                properties: {
                  object: { type: "string", enum: ["library"] },
                  applications: {
                    type: "array",
                    description:
                      "Applications belonging to the caller's organization. The default " +
                      "application (if any) is listed first.",
                    items: {
                      type: "object",
                      required: ["id", "name", "isDefault"],
                      properties: {
                        id: { type: "string", description: "Application id (`app_…`)." },
                        name: { type: "string" },
                        isDefault: { type: "boolean" },
                      },
                    },
                  },
                  packages: {
                    type: "object",
                    description:
                      "Packages grouped by type. Every group is always present (possibly empty).",
                    required: ["agent", "skill", "tool", "provider"],
                    properties: {
                      agent: { $ref: "#/components/schemas/LibraryPackageList" },
                      skill: { $ref: "#/components/schemas/LibraryPackageList" },
                      tool: { $ref: "#/components/schemas/LibraryPackageList" },
                      provider: { $ref: "#/components/schemas/LibraryPackageList" },
                    },
                  },
                },
              },
              example: {
                object: "library",
                applications: [
                  { id: "app_default", name: "Default", isDefault: true },
                  { id: "app_staging", name: "Staging", isDefault: false },
                ],
                packages: {
                  agent: [
                    {
                      id: "pkg_inbox_triage",
                      type: "agent",
                      source: "org",
                      name: "Inbox Triage",
                      description: "Sorts incoming Gmail threads into priority buckets.",
                      installedIn: ["app_default"],
                    },
                  ],
                  skill: [],
                  tool: [],
                  provider: [
                    {
                      id: "pkg_gmail",
                      type: "provider",
                      source: "system",
                      name: "Gmail",
                      description: "Google Mail OAuth provider.",
                      installedIn: ["app_default", "app_staging"],
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
