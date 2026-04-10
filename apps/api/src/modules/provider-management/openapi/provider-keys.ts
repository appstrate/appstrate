// SPDX-License-Identifier: Apache-2.0
export const providerKeysPaths = {
  "/api/provider-keys": {
    get: {
      operationId: "listProviderKeys",
      tags: ["Provider Keys"],
      summary: "List organization provider keys",
      description:
        "Returns all provider keys for the current organization. API keys are never exposed.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Provider key list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  keys: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrgProviderKey" },
                  },
                },
              },
              example: {
                keys: [
                  {
                    id: "cm7stu901",
                    label: "OpenAI Production",
                    api: "openai-responses",
                    baseUrl: "https://api.openai.com/v1",
                    source: "custom",
                    createdAt: "2026-01-10T08:00:00Z",
                    updatedAt: "2026-01-10T08:00:00Z",
                  },
                ],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    post: {
      operationId: "createProviderKey",
      tags: ["Provider Keys"],
      summary: "Create a provider key",
      description:
        "Create a new provider key for the organization. The API key is encrypted at rest.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["label", "api", "baseUrl", "apiKey"],
              properties: {
                label: {
                  type: "string",
                  minLength: 1,
                  description: "Display name for the provider key",
                },
                api: {
                  type: "string",
                  minLength: 1,
                  description:
                    "API type (openai-completions, openai-responses, anthropic-messages, google-generative-ai, google-vertex, azure-openai-responses, bedrock-converse-stream)",
                },
                baseUrl: {
                  type: "string",
                  format: "uri",
                  description: "Provider API base URL",
                },
                apiKey: { type: "string", minLength: 1, description: "API key for authentication" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Provider key created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
              },
              example: { id: "cm7stu902" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/provider-keys/test": {
    post: {
      operationId: "testProviderKeyInline",
      tags: ["Provider Keys"],
      summary: "Test provider key configuration inline",
      description:
        "Test a provider key configuration without saving it first. If editing an existing key, pass existingKeyId to fall back to its stored API key when apiKey is omitted. Rate limited to 5 requests per minute.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["api", "baseUrl"],
              properties: {
                api: { type: "string", minLength: 1, description: "API type" },
                baseUrl: {
                  type: "string",
                  format: "uri",
                  description: "Provider API base URL",
                },
                apiKey: {
                  type: "string",
                  description: "API key (required for new keys)",
                },
                existingKeyId: {
                  type: "string",
                  description: "Existing provider key ID to fall back to for stored API key",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Test result",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TestResult" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/provider-keys/{id}": {
    put: {
      operationId: "updateProviderKey",
      tags: ["Provider Keys"],
      summary: "Update a provider key",
      description: "Update a provider key configuration.",
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
              properties: {
                label: { type: "string", minLength: 1 },
                api: { type: "string", minLength: 1 },
                baseUrl: { type: "string", format: "uri" },
                apiKey: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Provider key updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { type: "object", properties: { id: { type: "string" } } },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    delete: {
      operationId: "deleteProviderKey",
      tags: ["Provider Keys"],
      summary: "Delete a provider key",
      description:
        "Delete a provider key. Models using this key will have their providerKeyId set to null.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Provider key deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/provider-keys/{id}/test": {
    post: {
      operationId: "testProviderKey",
      tags: ["Provider Keys"],
      summary: "Test provider key connection",
      description:
        "Test that the provider key's API key and base URL are valid by making a lightweight request to the provider. Rate limited to 5 requests per minute.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Test result",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TestResult" },
            },
          },
        },
        "404": {
          description: "Provider key not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TestResult" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
} as const;
