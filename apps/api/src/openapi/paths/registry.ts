export const registryPaths = {
  "/api/registry/connect": {
    post: {
      operationId: "registryConnect",
      tags: ["Registry"],
      summary: "Initiate registry OAuth connection",
      description:
        "Start an OAuth2/PKCE flow to connect the current user to the Appstrate registry. Returns an authorization URL to open in a popup.",
      responses: {
        "200": {
          description: "OAuth authorization URL",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["authUrl", "state"],
                properties: {
                  authUrl: { type: "string", description: "Authorization URL to open in popup" },
                  state: { type: "string", description: "OAuth state parameter" },
                },
              },
            },
          },
        },
        "500": {
          description: "Internal server error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },
  "/api/registry/callback": {
    get: {
      operationId: "registryCallback",
      tags: ["Registry"],
      summary: "Handle registry OAuth callback",
      description:
        "OAuth2 callback endpoint. Exchanges the authorization code for an access token. Returns HTML that closes the popup window.",
      parameters: [
        { name: "code", in: "query", schema: { type: "string" } },
        { name: "state", in: "query", schema: { type: "string" } },
        { name: "error", in: "query", schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "HTML page that closes the popup",
          content: { "text/html": { schema: { type: "string" } } },
        },
      },
    },
  },
  "/api/registry/disconnect": {
    delete: {
      operationId: "registryDisconnect",
      tags: ["Registry"],
      summary: "Disconnect from registry",
      description: "Remove the current user's registry connection.",
      responses: {
        "200": {
          description: "Disconnected",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { success: { type: "boolean" } },
              },
            },
          },
        },
      },
    },
  },
  "/api/registry/status": {
    get: {
      operationId: "registryStatus",
      tags: ["Registry"],
      summary: "Get registry connection status",
      description: "Check if the current user is connected to the registry.",
      responses: {
        "200": {
          description: "Connection status",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["connected"],
                properties: {
                  connected: { type: "boolean" },
                  username: { type: "string" },
                  expiresAt: { type: "string", format: "date-time" },
                  expired: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/registry/scopes": {
    get: {
      operationId: "registryScopes",
      tags: ["Registry"],
      summary: "List user's registry scopes",
      description: "Fetch the authenticated user's scopes from the registry.",
      responses: {
        "200": {
          description: "List of scopes",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  scopes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        ownerId: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
    post: {
      operationId: "registryClaimScope",
      tags: ["Registry"],
      summary: "Claim a registry scope",
      description: "Claim a new scope on the registry. Admin only.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", description: "Scope name to claim" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Scope claimed",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  scope: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      ownerId: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/packages/{scope}/{name}/publish-plan": {
    get: {
      operationId: "getPublishPlan",
      tags: ["Packages"],
      summary: "Get publish dependency plan",
      description:
        "Analyze the dependency graph of a package and return a topologically sorted publish plan. Shows which dependencies need to be published first.",
      parameters: [
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package scope (e.g. @org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
        {
          name: "version",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Target version to compute publish status for. If omitted, uses the current draft version.",
        },
        { $ref: "#/components/parameters/XOrgId" },
      ],
      responses: {
        "200": {
          description: "Publish plan with dependency order",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["items", "circular"],
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["packageId", "type", "displayName", "version", "status"],
                      properties: {
                        packageId: { type: "string" },
                        type: { type: "string", enum: ["flow", "skill", "extension", "provider"] },
                        displayName: { type: "string" },
                        version: { type: ["string", "null"] },
                        status: {
                          type: "string",
                          enum: [
                            "unpublished",
                            "outdated",
                            "published",
                            "no_version",
                            "version_behind",
                            "system",
                          ],
                        },
                      },
                    },
                  },
                  circular: {
                    type: ["array", "null"],
                    items: { type: "string" },
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
  "/api/packages/{scope}/{name}/publish": {
    post: {
      operationId: "publishPackage",
      tags: ["Packages"],
      summary: "Publish a package to the registry",
      description:
        "Publish a local package (flow, skill, extension, or provider) to the Appstrate registry. Requires registry connection. Admin only.",
      parameters: [
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package scope (e.g. @org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
        { $ref: "#/components/parameters/XOrgId" },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                version: {
                  type: "string",
                  description:
                    "Optional target version to publish (from local package versions). If omitted, the current draft version is used.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Package published",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  scope: { type: "string" },
                  name: { type: "string" },
                  version: { type: "string" },
                  integrity: { type: "string" },
                  size: { type: "number" },
                  type: { type: "string" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description: "Version conflict (already exists on registry)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        "500": {
          description: "Internal server error",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },
} as const;
