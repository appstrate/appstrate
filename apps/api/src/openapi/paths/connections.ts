export const connectionsPaths = {
  "/auth/connections": {
    get: {
      operationId: "listConnections",
      tags: ["Connections"],
      summary: "List active connections",
      description: "List active service connections for the current user in the org.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "profileId",
          in: "query",
          required: false,
          description: "Connection profile ID (defaults to user's default profile)",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Connection list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  connections: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ConnectionStatus" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/auth/integrations": {
    get: {
      operationId: "listIntegrations",
      tags: ["Connections"],
      summary: "List all providers with connection status",
      description:
        "List all configured providers with current connection status and auth mode for the user.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "profileId",
          in: "query",
          required: false,
          description: "Connection profile ID (defaults to user's default profile)",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Integration list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  integrations: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Integration" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/auth/connect/{provider}": {
    post: {
      operationId: "connectOAuth",
      tags: ["Connections"],
      summary: "Start OAuth2 flow",
      description:
        "Initiates OAuth2 authorization flow. Returns `authorizationUrl` to redirect the user.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "provider", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                scopes: { type: "array", items: { type: "string" } },
                profileId: { type: "string", description: "Connection profile ID" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "OAuth authorization URL",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  authUrl: { type: "string" },
                  state: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/auth/connect/{provider}/api-key": {
    post: {
      operationId: "connectApiKey",
      tags: ["Connections"],
      summary: "Save API key credential",
      description: "Save an API key credential for a provider that uses api_key auth mode.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "provider", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["apiKey"],
              properties: {
                apiKey: { type: "string", description: "API key value" },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "API key saved" },
        "400": { $ref: "#/components/responses/ValidationError" },
      },
    },
  },
  "/auth/connect/{provider}/credentials": {
    post: {
      operationId: "connectCredentials",
      tags: ["Connections"],
      summary: "Save custom credentials",
      description:
        "Save generic credentials for a provider that uses basic or custom auth mode. Fields depend on provider's credential schema.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "provider", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: true,
              description: "Credential fields matching the provider's credential schema",
            },
          },
        },
      },
      responses: {
        "200": { description: "Credentials saved" },
        "400": { $ref: "#/components/responses/ValidationError" },
      },
    },
  },
  "/auth/callback": {
    get: {
      operationId: "oauthCallback",
      tags: ["Connections"],
      summary: "OAuth2 callback",
      description:
        "OAuth2 callback handler — exchanges authorization code for tokens. Redirects to the frontend.",
      security: [],
      parameters: [
        { name: "code", in: "query", required: true, schema: { type: "string" } },
        { name: "state", in: "query", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": { description: "Tokens exchanged successfully (redirects via 302)" },
        "302": { description: "Redirect to frontend" },
      },
    },
  },
  "/auth/connections/{provider}": {
    delete: {
      operationId: "disconnectProvider",
      tags: ["Connections"],
      summary: "Disconnect a service",
      description: "Remove the active connection for a provider in the current org.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "provider", in: "path", required: true, schema: { type: "string" } },
        {
          name: "profileId",
          in: "query",
          required: false,
          description: "Connection profile ID (defaults to user's default profile)",
          schema: { type: "string" },
        },
      ],
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
} as const;
