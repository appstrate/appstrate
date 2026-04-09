// SPDX-License-Identifier: Apache-2.0

export const oauthClientsPaths = {
  "/api/applications/{id}/oauth": {
    post: {
      operationId: "enableEndUserAuth",
      tags: ["OAuth Clients"],
      summary: "Enable end-user auth for an application",
      description:
        "Creates an OAuth client for the application, enabling end-user OIDC authentication. Returns the client credentials (clientId and clientSecret). The clientSecret is only shown once.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["redirectUris"],
              properties: {
                redirectUris: {
                  type: "array",
                  items: { type: "string", format: "uri" },
                  minItems: 1,
                  description: "Allowed redirect URIs for the OAuth flow",
                },
                allowSignup: {
                  type: "boolean",
                  default: true,
                  description: "Whether end-users can sign up via the OIDC flow",
                },
                requireEmailVerification: {
                  type: "boolean",
                  default: true,
                  description: "Whether end-users must verify their email before access",
                },
              },
            },
            example: {
              redirectUris: ["https://myapp.example.com/callback"],
              allowSignup: true,
              requireEmailVerification: true,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "OAuth client created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["clientId", "clientSecret", "redirectUris", "enabled"],
                properties: {
                  clientId: { type: "string", description: "OAuth client ID" },
                  clientSecret: {
                    type: "string",
                    description: "OAuth client secret (only shown once)",
                  },
                  redirectUris: {
                    type: "array",
                    items: { type: "string", format: "uri" },
                  },
                  enabled: { type: "boolean" },
                },
              },
              example: {
                clientId: "abc123",
                clientSecret: "secret_xyz",
                redirectUris: ["https://myapp.example.com/callback"],
                enabled: true,
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description: "End-user auth already enabled for this application",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
    get: {
      operationId: "getEndUserAuthConfig",
      tags: ["OAuth Clients"],
      summary: "Get end-user auth config for an application",
      description:
        "Returns the current end-user auth configuration for an application. If not enabled, returns `{ enabled: false }`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "OAuth config",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["enabled"],
                properties: {
                  enabled: { type: "boolean" },
                  clientId: { type: "string", description: "OAuth client ID" },
                  allowSignup: { type: "boolean" },
                  requireEmailVerification: { type: "boolean" },
                  redirectUris: {
                    type: "array",
                    items: { type: "string", format: "uri" },
                  },
                },
              },
              example: {
                enabled: true,
                clientId: "abc123",
                allowSignup: true,
                requireEmailVerification: true,
                redirectUris: ["https://myapp.example.com/callback"],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    patch: {
      operationId: "updateEndUserAuthConfig",
      tags: ["OAuth Clients"],
      summary: "Update end-user auth config",
      description:
        "Update end-user auth settings for an application. End-user auth must be enabled first via POST.",
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
                redirectUris: {
                  type: "array",
                  items: { type: "string", format: "uri" },
                  minItems: 1,
                },
                allowSignup: { type: "boolean" },
                requireEmailVerification: { type: "boolean" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Config updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  updated: { type: "boolean" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    delete: {
      operationId: "disableEndUserAuth",
      tags: ["OAuth Clients"],
      summary: "Disable end-user auth for an application",
      description: "Disables end-user OIDC authentication for the application.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "End-user auth disabled",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  enabled: { type: "boolean", enum: [false] },
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
