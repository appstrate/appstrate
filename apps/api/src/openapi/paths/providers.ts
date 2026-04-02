// SPDX-License-Identifier: Apache-2.0

export const providersPaths = {
  "/api/providers": {
    get: {
      operationId: "listProviders",
      tags: ["Providers"],
      summary: "List all providers",
      description:
        "List all provider configurations (built-in + custom) for the organization. Available to all org members.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Provider list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  providers: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ProviderConfig" },
                  },
                  callbackUrl: { type: "string" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
    post: {
      operationId: "createProvider",
      tags: ["Providers"],
      summary: "Create a custom provider",
      description: "Create a new provider configuration.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ProviderConfigInput" },
          },
        },
      },
      responses: {
        "201": {
          description: "Provider created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/providers/{scope}/{name}": {
    put: {
      operationId: "updateProvider",
      tags: ["Providers"],
      summary: "Update a provider",
      description: "Update a custom provider configuration. Built-in providers cannot be modified.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
        },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ProviderConfigInput" },
          },
        },
      },
      responses: {
        "200": {
          description: "Provider updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteProvider",
      tags: ["Providers"],
      summary: "Delete a provider",
      description:
        "Delete a custom provider. Built-in providers cannot be deleted. Cannot delete if used by agents.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
        },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Provider deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": { description: "Provider in use by agents" },
      },
    },
  },
  "/api/providers/credentials/{scope}/{name}": {
    delete: {
      operationId: "deleteProviderCredentials",
      tags: ["Providers"],
      summary: "Delete provider credentials",
      description: "Remove admin credentials for a provider.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
        },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Credentials deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { configured: { type: "boolean" } },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    put: {
      operationId: "configureProviderCredentials",
      tags: ["Providers"],
      summary: "Configure provider credentials",
      description: "Set OAuth client credentials for a provider.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
        },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                credentials: {
                  type: "object",
                  additionalProperties: { type: "string" },
                  description:
                    "Key-value pairs matching the provider's adminCredentialSchema fields. Optional for non-OAuth providers.",
                },
                enabled: {
                  type: "boolean",
                  description: "Whether to enable this provider for use",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Credentials configured",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { configured: { type: "boolean" } },
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
