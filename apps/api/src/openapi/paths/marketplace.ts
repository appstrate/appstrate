export const marketplacePaths = {
  "/api/marketplace/status": {
    get: {
      operationId: "getMarketplaceStatus",
      tags: ["Marketplace"],
      summary: "Check registry connection status",
      description: "Returns whether the Appstrate Registry is configured and reachable.",
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
        "Search for packages in the Appstrate Registry. Returns paginated results with optional type and sort filters.",
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
  "/api/marketplace/packages/{scope}/{name}": {
    get: {
      operationId: "getMarketplacePackage",
      tags: ["Marketplace"],
      summary: "Get marketplace package detail",
      description:
        "Get full package details from the Appstrate Registry, including versions and metadata.",
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
          description: "Package detail from registry",
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
        "Downloads and installs a package from the Appstrate Registry into the organization. Admin only. Validates that all registryDependencies are already installed in the org before proceeding.",
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
                },
              },
            },
          },
        },
        "400": {
          description: "Validation error or missing dependencies",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "string",
                    description: "Error code (MISSING_DEPENDENCIES or VALIDATION_ERROR)",
                  },
                  message: { type: "string" },
                  missing: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        packageId: { type: "string" },
                        type: { type: "string" },
                      },
                    },
                    description:
                      "List of missing dependency packages (only for MISSING_DEPENDENCIES)",
                  },
                },
              },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
} as const;
