export const connectionsPaths = {
  "/auth/connections": {
    get: {
      operationId: "listConnections",
      tags: ["Connections"],
      summary: "List active connections",
      description: "List active provider connections for the current user in the org.",
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
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
  "/auth/connect/{scope}/{name}": {
    post: {
      operationId: "connectOAuth",
      tags: ["Connections"],
      summary: "Start OAuth connection flow",
      description:
        "Initiates OAuth authorization flow (OAuth2 or OAuth1 depending on provider). Returns `authUrl` to redirect the user.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Provider scope (e.g. @appstrate)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Provider name (e.g. gmail)",
        },
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
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
  "/auth/connect/{scope}/{name}/api-key": {
    post: {
      operationId: "connectApiKey",
      tags: ["Connections"],
      summary: "Save API key credential",
      description: "Save an API key credential for a provider that uses api_key auth mode.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Provider scope (e.g. @appstrate)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Provider name (e.g. gmail)",
        },
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
                profileId: {
                  type: "string",
                  format: "uuid",
                  description: "Connection profile ID (defaults to user's default profile)",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "API key saved",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { success: { type: "boolean" } },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
      },
    },
  },
  "/auth/connect/{scope}/{name}/credentials": {
    post: {
      operationId: "connectCredentials",
      tags: ["Connections"],
      summary: "Save custom credentials",
      description:
        "Save generic credentials for a provider that uses basic or custom auth mode. Fields depend on provider's credential schema.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Provider scope (e.g. @appstrate)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Provider name (e.g. gmail)",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["credentials"],
              properties: {
                credentials: {
                  type: "object",
                  additionalProperties: { type: "string" },
                  description: "Credential fields matching the provider's credential schema",
                },
                profileId: {
                  type: "string",
                  format: "uuid",
                  description: "Connection profile ID (defaults to user's default profile)",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Credentials saved",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { success: { type: "boolean" } },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
      },
    },
  },
  "/auth/callback": {
    get: {
      operationId: "oauthCallback",
      tags: ["Connections"],
      summary: "OAuth2/OAuth1 callback",
      description:
        "OAuth callback handler. Supports both OAuth2 (code+state) and OAuth1 (oauth_token+oauth_verifier). Exchanges tokens and closes the popup window.",
      security: [],
      parameters: [
        {
          name: "code",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "OAuth2 authorization code",
        },
        {
          name: "state",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "OAuth2 state parameter",
        },
        {
          name: "oauth_token",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "OAuth1 request token",
        },
        {
          name: "oauth_verifier",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "OAuth1 verifier",
        },
        {
          name: "error",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "OAuth error code",
        },
      ],
      responses: {
        "200": {
          description: "Tokens exchanged successfully, popup closes",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
        },
      },
    },
  },
  "/auth/connections/{scope}/{name}": {
    delete: {
      operationId: "disconnectProvider",
      tags: ["Connections"],
      summary: "Disconnect a provider",
      description:
        "Remove a connection for a provider. If `connectionId` is provided, deletes only that specific connection. Otherwise, deletes all connections for the provider on the profile.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Provider scope (e.g. @appstrate)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Provider name (e.g. gmail)",
        },
        {
          name: "profileId",
          in: "query",
          required: false,
          description: "Connection profile ID (defaults to user's default profile)",
          schema: { type: "string" },
        },
        {
          name: "connectionId",
          in: "query",
          required: false,
          description:
            "Specific connection ID to delete. When provided, only this connection is removed (ignores profileId).",
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Disconnected",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
