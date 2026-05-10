// SPDX-License-Identifier: Apache-2.0

export const modelProviderCredentialsPaths = {
  "/api/model-provider-credentials/registry": {
    get: {
      operationId: "listModelProviderRegistry",
      tags: ["Model Provider Credentials"],
      summary: "List the in-code model provider registry",
      description:
        "Returns the catalog of LLM providers Appstrate knows how to talk to (Codex, Claude Code, OpenAI, Anthropic, OpenAI-compatible). The UI uses this to render the provider picker without hard-coding the catalog client-side.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Model provider registry list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      required: [
                        "providerId",
                        "displayName",
                        "iconUrl",
                        "apiShape",
                        "defaultBaseUrl",
                        "baseUrlOverridable",
                        "authMode",
                        "models",
                      ],
                      properties: {
                        providerId: { type: "string" },
                        displayName: { type: "string" },
                        iconUrl: { type: "string" },
                        description: { type: ["string", "null"] },
                        docsUrl: { type: ["string", "null"] },
                        apiShape: {
                          type: "string",
                          enum: ["anthropic-messages", "openai-chat", "openai-responses"],
                        },
                        defaultBaseUrl: { type: "string" },
                        baseUrlOverridable: { type: "boolean" },
                        authMode: { type: "string", enum: ["api_key", "oauth2"] },
                        models: {
                          type: "array",
                          items: {
                            type: "object",
                            required: ["id", "contextWindow", "capabilities"],
                            properties: {
                              id: { type: "string" },
                              contextWindow: { type: "integer" },
                              maxTokens: { type: ["integer", "null"] },
                              capabilities: { type: "array", items: { type: "string" } },
                            },
                          },
                        },
                      },
                    },
                  },
                  hasMore: { type: "boolean" },
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
  "/api/model-provider-credentials": {
    get: {
      operationId: "listModelProviderCredentials",
      tags: ["Model Provider Credentials"],
      summary: "List organization model provider credentials",
      description:
        "Returns all LLM model provider credentials (Anthropic, OpenAI, Codex, Claude Code, etc.) for the current organization. Plaintext keys / OAuth tokens are never exposed.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Model provider credentials list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrgModelProviderKey" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "cm7stu901",
                    label: "OpenAI Production",
                    api: "openai-chat",
                    baseUrl: "https://api.openai.com",
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
      operationId: "createModelProviderCredential",
      tags: ["Model Provider Credentials"],
      summary: "Create a model provider credential",
      description:
        "Create a new LLM model provider credential for the organization. The plaintext API key is encrypted at rest under a versioned envelope.",
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
                  description: "Display name for the model provider credential",
                },
                api: {
                  type: "string",
                  minLength: 1,
                  description:
                    "API wire format (anthropic-messages, openai-chat, openai-responses, openai-completions, …). Combined with baseUrl to reverse-resolve the registry providerId.",
                },
                baseUrl: {
                  type: "string",
                  format: "uri",
                  description: "Model provider API base URL",
                },
                apiKey: { type: "string", minLength: 1, description: "API key for authentication" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Model provider credential created",
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
  "/api/model-provider-credentials/test": {
    post: {
      operationId: "testModelProviderCredentialInline",
      tags: ["Model Provider Credentials"],
      summary: "Test model provider credential configuration inline",
      description:
        "Test a model provider credential configuration without saving it first. If editing an existing credential, pass existingKeyId to fall back to its stored API key when apiKey is omitted. Rate limited to 5 requests per minute.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["api", "baseUrl"],
              properties: {
                api: { type: "string", minLength: 1, description: "API wire format" },
                baseUrl: {
                  type: "string",
                  format: "uri",
                  description: "Model provider API base URL",
                },
                apiKey: {
                  type: "string",
                  description: "API key (required for new credentials)",
                },
                existingKeyId: {
                  type: "string",
                  description: "Existing credential ID to fall back to for stored API key",
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
  "/api/model-provider-credentials/{id}": {
    put: {
      operationId: "updateModelProviderCredential",
      tags: ["Model Provider Credentials"],
      summary: "Update a model provider credential",
      description:
        "Update a model provider credential's mutable fields. The `api` and `baseUrl` of an existing credential are pinned by the canonical `providerId` selected at create time and cannot be changed — delete and re-create the credential to switch providers.",
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
                apiKey: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Model provider credential updated",
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
      operationId: "deleteModelProviderCredential",
      tags: ["Model Provider Credentials"],
      summary: "Delete a model provider credential",
      description:
        "Delete a model provider credential. Rejected with 409/500 if any org_models row still references it (FK ON DELETE RESTRICT) — detach the model first.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Model provider credential deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/model-provider-credentials/{id}/test": {
    post: {
      operationId: "testModelProviderCredential",
      tags: ["Model Provider Credentials"],
      summary: "Test model provider credential connection",
      description:
        "Test that the credential's API key (or OAuth token) and base URL are valid by making a lightweight request to the provider. Rate limited to 5 requests per minute.",
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
          description: "Model provider credential not found",
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
