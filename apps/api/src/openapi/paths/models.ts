// SPDX-License-Identifier: Apache-2.0

export const modelsPaths = {
  "/api/models": {
    get: {
      operationId: "listModels",
      tags: ["Models"],
      summary: "List organization models",
      description: "Returns all models (built-in + custom) for the current organization.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Model list",
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
                    items: { $ref: "#/components/schemas/OrgModel" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "gpt-4o",
                    label: "GPT-4o",
                    apiShape: "openai-responses",
                    baseUrl: "https://api.openai.com/v1",
                    modelId: "gpt-4o",
                    source: "built-in",
                    enabled: true,
                    isDefault: false,
                    credentialId: "pk_abc123",
                    contextWindow: 128000,
                    maxTokens: 16384,
                    reasoning: false,
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
      operationId: "createModel",
      tags: ["Models"],
      summary: "Create a custom model",
      description: "Create a new custom LLM model for the organization.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["modelId", "credentialId"],
              properties: {
                label: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Display name for the model. Optional — the server derives one from the catalog (or `modelId` on miss) when omitted, deduping against existing org rows.",
                },
                modelId: {
                  type: "string",
                  minLength: 1,
                  description: "Model identifier (e.g. gpt-4o)",
                },
                credentialId: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Provider credential ID. The provider's apiShape and baseUrl are resolved from the credential's providerId.",
                },
                input: {
                  type: "array",
                  items: { type: "string" },
                  description: "Supported input types",
                },
                contextWindow: { type: "integer", description: "Context window size in tokens" },
                maxTokens: { type: "integer", description: "Maximum output tokens" },
                reasoning: { type: "boolean", description: "Whether the model supports reasoning" },
                cost: {
                  type: "object",
                  description: "Cost per million tokens (input/output/cacheRead/cacheWrite)",
                  properties: {
                    input: { type: "number" },
                    output: { type: "number" },
                    cacheRead: { type: "number" },
                    cacheWrite: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Model created",
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
              example: { id: "cm5mno345" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/models/default": {
    put: {
      operationId: "setDefaultModel",
      tags: ["Models"],
      summary: "Set the organization default model",
      description:
        "Set or unset the default model for the organization. Pass null to remove the default.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["modelId"],
              properties: {
                modelId: {
                  type: ["string", "null"],
                  description: "Model ID to set as default, or null to unset",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Default model updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/models/seed": {
    post: {
      operationId: "seedModels",
      tags: ["Models"],
      summary: "Bulk-seed models from the registry for a credential",
      description:
        "Atomically seed multiple `org_models` rows from the registry entry pinned by the credential's `providerId`. Idempotent — returns `created: 0` when the org already has any model bound to this credential.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["credentialId", "modelIds"],
              properties: {
                credentialId: { type: "string", minLength: 1 },
                modelIds: {
                  type: "array",
                  minItems: 1,
                  maxItems: 50,
                  items: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Models seeded",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["created", "ids", "promotedDefault"],
                properties: {
                  created: { type: "integer", minimum: 0 },
                  ids: { type: "array", items: { type: "string" } },
                  promotedDefault: { type: "boolean" },
                },
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
  },
  "/api/models/openrouter": {
    get: {
      operationId: "searchOpenRouterModels",
      tags: ["Models"],
      summary: "Search OpenRouter models",
      description:
        "Search available models on OpenRouter. Results include model capabilities (context window, max tokens, input modalities). Rate limited to 10 requests per minute.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Search query to filter models by name or ID",
        },
      ],
      responses: {
        "200": {
          description: "Model search results",
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
                      properties: {
                        id: {
                          type: "string",
                          description: "Model ID (e.g. anthropic/claude-3-opus)",
                        },
                        name: { type: "string", description: "Human-readable model name" },
                        contextWindow: {
                          type: ["integer", "null"],
                          description: "Context window size",
                        },
                        maxTokens: { type: ["integer", "null"], description: "Max output tokens" },
                        input: {
                          type: "array",
                          items: { type: "string" },
                          description: "Supported input types",
                        },
                        reasoning: {
                          type: "boolean",
                          description: "Whether model supports reasoning",
                        },
                      },
                    },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "anthropic/claude-sonnet-4",
                    name: "Claude Sonnet 4",
                    contextWindow: 200000,
                    maxTokens: 16384,
                    input: ["text", "image"],
                    reasoning: true,
                  },
                ],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "502": {
          description: "OpenRouter API error",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Bad Gateway",
                status: 502,
                detail: "OpenRouter API returned an unexpected error",
                code: "bad_gateway",
                requestId: "req_abc123",
              },
            },
          },
        },
        "504": {
          description: "OpenRouter request timeout",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Gateway Timeout",
                status: 504,
                detail: "OpenRouter did not respond within the allowed time",
                code: "gateway_timeout",
                requestId: "req_def456",
              },
            },
          },
        },
      },
    },
  },
  "/api/models/test": {
    post: {
      operationId: "testModelInline",
      tags: ["Models"],
      summary: "Test model configuration inline",
      description:
        "Test a model configuration without saving it first. If editing an existing model, pass existingModelId to fall back to its stored API key when apiKey is omitted. Rate limited to 5 requests per minute.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["credentialId", "modelId"],
              properties: {
                credentialId: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Provider credential ID. apiShape and baseUrl are resolved from the credential's providerId.",
                },
                modelId: { type: "string", minLength: 1, description: "Model identifier" },
                apiKey: {
                  type: "string",
                  description:
                    "Override API key for the probe. Falls back to existingModelId's key, then the credential's stored key.",
                },
                existingModelId: {
                  type: "string",
                  description: "Existing model ID to fall back to for stored API key",
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
  "/api/models/{id}": {
    put: {
      operationId: "updateModel",
      tags: ["Models"],
      summary: "Update a custom model",
      description: "Update a custom model configuration. Built-in models cannot be modified.",
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
                modelId: { type: "string", minLength: 1 },
                credentialId: {
                  type: "string",
                  description: "Provider key ID to change which key is used",
                },
                enabled: { type: "boolean" },
                input: { type: ["array", "null"], items: { type: "string" } },
                contextWindow: { type: ["integer", "null"] },
                maxTokens: { type: ["integer", "null"] },
                reasoning: { type: ["boolean", "null"] },
                cost: {
                  type: ["object", "null"],
                  description: "Cost per million tokens (input/output/cacheRead/cacheWrite)",
                  properties: {
                    input: { type: "number" },
                    output: { type: "number" },
                    cacheRead: { type: "number" },
                    cacheWrite: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Model updated",
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
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    delete: {
      operationId: "deleteModel",
      tags: ["Models"],
      summary: "Delete a custom model",
      description: "Delete a custom model. Built-in models cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Model deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/models/{id}/test": {
    post: {
      operationId: "testModel",
      tags: ["Models"],
      summary: "Test model connection",
      description:
        "Test that the model's API key and base URL are valid by making a lightweight request to the provider. Rate limited to 5 requests per minute.",
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
          description: "Model not found",
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
