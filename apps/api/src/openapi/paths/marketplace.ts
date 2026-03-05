export const marketplacePaths = {
  "/api/marketplace/status": {
    get: {
      operationId: "getMarketplaceStatus",
      tags: ["Marketplace"],
      summary: "Check registry connection status",
      description: "Returns whether the Appstrate [registry] is configured and reachable.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Registry status",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["configured"],
                properties: {
                  configured: {
                    type: "boolean",
                    description: "Whether a registry URL is configured",
                  },
                  registryUrl: {
                    type: "string",
                    description: "The configured registry URL (if any)",
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/marketplace/search": {
    get: {
      operationId: "searchMarketplace",
      tags: ["Marketplace"],
      summary: "Search marketplace packages",
      description:
        "Search for packages in the Appstrate [registry]. Returns paginated results with optional type and sort filters.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "q",
          in: "query",
          schema: { type: "string" },
          description: "Search query",
        },
        {
          name: "type",
          in: "query",
          schema: { type: "string", enum: ["flow", "skill", "extension"] },
          description: "Filter by package type",
        },
        {
          name: "sort",
          in: "query",
          schema: { type: "string", enum: ["relevance", "downloads", "recent"] },
          description: "Sort order",
        },
        {
          name: "page",
          in: "query",
          schema: { type: "integer", default: 1 },
          description: "Page number",
        },
        {
          name: "per_page",
          in: "query",
          schema: { type: "integer", default: 20 },
          description: "Results per page",
        },
      ],
      responses: {
        "200": {
          description: "Search results",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  packages: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        scope: { type: "string" },
                        name: { type: "string" },
                        type: { type: "string" },
                        description: { type: "string" },
                        latestVersion: { type: "string" },
                        downloads: { type: "integer" },
                      },
                    },
                  },
                  total: { type: "integer" },
                  page: { type: "integer" },
                  perPage: { type: "integer" },
                },
              },
            },
          },
        },
        "400": {
          description: "Registry not configured",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
              example: {
                error: "REGISTRY_NOT_CONFIGURED",
                message: "No registry URL configured",
              },
            },
          },
        },
      },
    },
  },
  "/api/marketplace/installed": {
    get: {
      operationId: "getInstalledRegistryPackages",
      tags: ["Marketplace"],
      summary: "List installed registry packages",
      description: "Returns all packages in the org that were installed from the registry.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Installed registry packages",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  packages: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        type: { type: "string" },
                        registryScope: {
                          type: ["string", "null"],
                          description: "Derived from package ID",
                        },
                        registryName: {
                          type: ["string", "null"],
                          description: "Derived from package ID",
                        },
                        manifest: {
                          type: ["object", "null"],
                          description:
                            "Package manifest (source of truth for displayName, description, version, etc.)",
                        },
                        updatedAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/marketplace/updates": {
    get: {
      operationId: "checkRegistryUpdates",
      tags: ["Marketplace"],
      summary: "Check for registry updates",
      description:
        "Compares installed registry package versions against latest available versions.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Update status for each installed registry package",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  updates: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        type: { type: "string" },
                        scope: { type: "string" },
                        name: { type: "string" },
                        displayName: { type: "string" },
                        installedVersion: { type: "string" },
                        latestVersion: { type: "string" },
                        updateAvailable: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "502": {
          description: "Registry communication error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },
  "/api/marketplace/update": {
    post: {
      operationId: "updateMarketplacePackage",
      tags: ["Marketplace"],
      summary: "Update an installed package to latest",
      description: "Re-installs an installed registry package at the latest version. Admin only.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["scope", "name"],
              properties: {
                scope: { type: "string", description: "Package scope (e.g. @demo)" },
                name: { type: "string", description: "Package name" },
                accessToken: { type: "string", description: "Optional registry access token" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Package updated",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  packageId: { type: "string" },
                  type: { type: "string" },
                  version: { type: "string" },
                  autoInstalledDeps: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        packageId: { type: "string" },
                        type: { type: "string" },
                        version: { type: ["string", "null"] },
                      },
                    },
                    description: "List of dependencies that were automatically installed",
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "Validation error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/marketplace/packages/{scope}/{name}": {
    get: {
      operationId: "getMarketplacePackage",
      tags: ["Marketplace"],
      summary: "Get marketplace package detail",
      description:
        "Get full package details from the Appstrate [registry], including versions, metadata, and install status.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package scope (with or without @ prefix)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Package detail from registry with install status",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  scope: { type: "string" },
                  name: { type: "string" },
                  type: { type: "string" },
                  description: { type: "string" },
                  readme: { type: "string" },
                  versions: { type: "array", items: { type: "object" } },
                  installedVersion: {
                    type: ["string", "null"],
                    description: "Currently installed version in the org (null if not installed)",
                  },
                  integrityConflict: {
                    type: "boolean",
                    description:
                      "True when a local package with the same ID exists but has different integrity than all registry versions",
                  },
                  localVersionAhead: {
                    type: ["string", "null"],
                    description:
                      "When the highest local version is greater than the registry latest, contains that version string. Null otherwise.",
                  },
                },
              },
            },
          },
        },
        "502": {
          description: "Registry communication error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },
  "/api/marketplace/install": {
    post: {
      operationId: "installFromMarketplace",
      tags: ["Marketplace"],
      summary: "Install a package from marketplace",
      description:
        "Downloads and installs a package from the Appstrate [registry] into the organization. Admin only. Missing registryDependencies are automatically installed and marked as auto-installed.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["scope", "name"],
              properties: {
                scope: { type: "string", description: "Package scope (e.g. @demo)" },
                name: { type: "string", description: "Package name" },
                version: {
                  type: "string",
                  description: "Specific version to install (defaults to latest)",
                },
                accessToken: { type: "string", description: "Optional registry access token" },
                force: {
                  type: "boolean",
                  description:
                    "Skip integrity conflict check and force install over a local package with different content",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Package installed",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  packageId: { type: "string" },
                  type: { type: "string" },
                  version: { type: "string" },
                  autoInstalledDeps: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        packageId: { type: "string" },
                        type: { type: "string" },
                        version: { type: ["string", "null"] },
                      },
                    },
                    description: "List of dependencies that were automatically installed",
                  },
                },
              },
            },
          },
        },
        "400": {
          description: "Validation error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
} as const;
