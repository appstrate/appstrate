// SPDX-License-Identifier: Apache-2.0

export const applicationsPaths = {
  "/api/applications": {
    post: {
      operationId: "createApplication",
      tags: ["Applications"],
      summary: "Create an application",
      description:
        "Create a new application for the organization. Applications scope end-users and their sessions.",
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
                  description: "Human-readable application name",
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
                  description: "Application settings",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Application created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApplicationObject" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    get: {
      operationId: "listApplications",
      tags: ["Applications"],
      summary: "List applications",
      description: "List all applications for the organization.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Application list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ApplicationObject" },
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
  "/api/applications/{id}": {
    get: {
      operationId: "getApplication",
      tags: ["Applications"],
      summary: "Get an application",
      description: "Get a single application by ID.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Application detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApplicationObject" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    patch: {
      operationId: "updateApplication",
      tags: ["Applications"],
      summary: "Update an application",
      description: "Update application name or settings.",
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
                  description: "Human-readable application name",
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
                  description: "Application settings",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Application updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApplicationObject" },
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
      operationId: "deleteApplication",
      tags: ["Applications"],
      summary: "Delete an application",
      description:
        "Delete an application and all associated end-users. The default application cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Application deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/applications/{appId}/packages": {
    get: {
      operationId: "listInstalledPackages",
      tags: ["Application Packages"],
      summary: "List installed packages",
      description:
        "List all packages installed in this application, with their config and version.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "appId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "type",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["agent", "skill", "tool", "provider"] },
          description: "Filter by package type",
        },
      ],
      responses: {
        "200": {
          description: "Installed packages list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ApplicationPackage" },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "installPackage",
      tags: ["Application Packages"],
      summary: "Install a package",
      description: "Install a package from the organization catalog into this application.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "appId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["packageId"],
              properties: {
                packageId: { type: "string", description: "Package ID from org catalog" },
                config: { type: "object", description: "Initial configuration" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Package installed",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Package already installed in this application",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/applications/{appId}/packages/{scope}/{name}": {
    get: {
      operationId: "getInstalledPackage",
      tags: ["Application Packages"],
      summary: "Get installed package",
      description: "Get an installed package detail with its config.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "appId", in: "path", required: true, schema: { type: "string" } },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Installed package detail",
          headers: { "Request-Id": { $ref: "#/components/headers/RequestId" } },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateInstalledPackage",
      tags: ["Application Packages"],
      summary: "Update installed package config",
      description:
        "Update configuration, model/proxy overrides, or version pinning for an installed package.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "appId", in: "path", required: true, schema: { type: "string" } },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                config: { type: "object" },
                modelId: { type: ["string", "null"] },
                proxyId: { type: ["string", "null"] },
                orgProfileId: { type: ["string", "null"] },
                versionId: { type: ["integer", "null"] },
                enabled: { type: "boolean" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated package config",
          headers: { "Request-Id": { $ref: "#/components/headers/RequestId" } },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "uninstallPackage",
      tags: ["Application Packages"],
      summary: "Uninstall a package",
      description: "Remove a package from this application.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "appId", in: "path", required: true, schema: { type: "string" } },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Package uninstalled" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/applications/{appId}/providers": {
    get: {
      operationId: "listAppProviderOverrides",
      tags: ["Application Providers"],
      summary: "List app-level provider overrides",
      description:
        "List all application-level provider credential overrides and enablement status.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "appId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Provider overrides list",
          headers: { "Request-Id": { $ref: "#/components/headers/RequestId" } },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        providerId: { type: "string" },
                        hasAppCredentials: { type: "boolean" },
                        appEnabled: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/applications/{appId}/providers/{scope}/{name}/credentials": {
    put: {
      operationId: "setAppProviderCredentials",
      tags: ["Application Providers"],
      summary: "Set app-level provider credentials",
      description:
        "Set or update application-level provider admin credentials (e.g. OAuth clientId/clientSecret). These override org-level credentials for this application. The provider must be enabled at org level.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "appId", in: "path", required: true, schema: { type: "string" } },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                credentials: {
                  type: "object",
                  additionalProperties: { type: "string" },
                  description:
                    "Admin credentials (e.g. clientId, clientSecret for OAuth providers)",
                },
                enabled: {
                  type: "boolean",
                  description:
                    "Whether the provider is enabled for this application. Can only restrict (disable), not override an org-level disable.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Credentials configured",
          headers: { "Request-Id": { $ref: "#/components/headers/RequestId" } },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { configured: { type: "boolean" } },
              },
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
      operationId: "deleteAppProviderCredentials",
      tags: ["Application Providers"],
      summary: "Remove app-level provider credentials",
      description:
        "Remove the application-level override for a provider, reverting to org-level credentials.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "appId", in: "path", required: true, schema: { type: "string" } },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Override removed",
          headers: { "Request-Id": { $ref: "#/components/headers/RequestId" } },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
