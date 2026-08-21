// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS, REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

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
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApplicationObject" },
              example: {
                id: "app_cm1xyz789ghi012",
                object: "application",
                orgId: "550e8400-e29b-41d4-a716-446655440000",
                name: "My SaaS App",
                isDefault: false,
                settings: {
                  allowedRedirectDomains: ["myapp.com", "staging.myapp.com"],
                },
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
      operationId: "listApplications",
      tags: ["Applications"],
      summary: "List applications",
      description: "List all applications for the organization.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Application list",
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
                    items: { $ref: "#/components/schemas/ApplicationObject" },
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
                    id: "app_default001",
                    object: "application",
                    orgId: "550e8400-e29b-41d4-a716-446655440000",
                    name: "Default",
                    isDefault: true,
                    settings: { allowedRedirectDomains: [] },
                    created_by: null,
                    createdAt: "2026-01-10T08:00:00Z",
                    updatedAt: "2026-01-10T08:00:00Z",
                  },
                  {
                    id: "app_cm1xyz789ghi012",
                    object: "application",
                    orgId: "550e8400-e29b-41d4-a716-446655440000",
                    name: "My SaaS App",
                    isDefault: false,
                    settings: { allowedRedirectDomains: ["myapp.com"] },
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
          headers: STD_RESPONSE_HEADERS,
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
          headers: STD_RESPONSE_HEADERS,
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
          headers: REQUEST_ID_ONLY_HEADERS,
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/applications/{applicationId}/packages": {
    get: {
      operationId: "listInstalledPackages",
      tags: ["Application Packages"],
      summary: "List installed packages",
      description:
        "List all packages installed in this application, with their model/proxy/version overrides.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "applicationId", in: "path", required: true, schema: { type: "string" } },
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
                    items: { $ref: "#/components/schemas/ApplicationPackage" },
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
        { name: "applicationId", in: "path", required: true, schema: { type: "string" } },
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
              schema: { $ref: "#/components/schemas/ApplicationPackage" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
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
  "/api/applications/{applicationId}/packages/{scope}/{name}": {
    get: {
      operationId: "getInstalledPackage",
      tags: ["Application Packages"],
      summary: "Get installed package",
      description: "Get an installed package detail with its model/proxy/version overrides.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "applicationId", in: "path", required: true, schema: { type: "string" } },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Installed package detail",
          headers: REQUEST_ID_ONLY_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ApplicationPackage" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateInstalledPackage",
      tags: ["Application Packages"],
      summary: "Update installed package overrides",
      description:
        "Update the model/proxy overrides, generation settings, enabled flag, or version pinning for an installed package. The agent's stored input values are NOT settable here — use `PUT /api/agents/{scope}/{name}/input-settings`, which validates them against the manifest input schema.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "applicationId", in: "path", required: true, schema: { type: "string" } },
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
              schema: { $ref: "#/components/schemas/ApplicationPackage" },
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
      tags: ["Application Packages"],
      summary: "Uninstall a package",
      description: "Remove a package from this application.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "applicationId", in: "path", required: true, schema: { type: "string" } },
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
  "/api/applications/{applicationId}/packages/{scope}/{name}/run-config": {
    get: {
      operationId: "getApplicationPackageRunConfig",
      tags: ["Application Packages"],
      summary: "Get the resolved per-app run configuration",
      description:
        "Returns the configuration applied when this application runs the given package: model override, generation settings, proxy override, pinned version label, and the stored input layer (editor values plus locked fields). Used by the CLI to reproduce a UI run without stitching together three separate calls; the UI uses the same source for its run-from-app flow.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "applicationId", in: "path", required: true, schema: { type: "string" } },
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
                    description:
                      "Stored input layer for this application — the editor's values and the fields it locked. A locally executed run applies `values` under the caller's input and refuses a caller value naming a locked field.",
                    required: ["values", "locked_fields"],
                    properties: {
                      values: { type: "object", additionalProperties: true },
                      locked_fields: { type: "array", items: { type: "string" } },
                    },
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
} as const;
