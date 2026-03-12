export const modelsPaths = {
  "/api/models": {
    get: {
      operationId: "listModels",
      tags: ["Models"],
      summary: "List organization models",
      description:
        "Returns all models (built-in + custom) for the current organization. Admin only.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Model list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  models: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrgModel" },
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
    post: {
      operationId: "createModel",
      tags: ["Models"],
      summary: "Create a custom model",
      description: "Create a new custom LLM model for the organization. Admin only.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["label", "api", "baseUrl", "modelId", "apiKey"],
              properties: {
                label: { type: "string", description: "Display name for the model" },
                api: {
                  type: "string",
                  description:
                    "API type (openai-completions, anthropic-messages, google-generative-ai)",
                },
                baseUrl: { type: "string", format: "uri", description: "Provider API base URL" },
                modelId: { type: "string", description: "Model identifier (e.g. gpt-4o)" },
                apiKey: { type: "string", description: "API key for authentication" },
                input: {
                  type: "array",
                  items: { type: "string" },
                  description: "Supported input types",
                },
                contextWindow: { type: "integer", description: "Context window size in tokens" },
                maxTokens: { type: "integer", description: "Maximum output tokens" },
                reasoning: { type: "boolean", description: "Whether the model supports reasoning" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Model created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
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
        "Set or unset the default model for the organization. Pass null to remove the default. Admin only.",
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
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/models/test": {
    post: {
      operationId: "testModelInline",
      tags: ["Models"],
      summary: "Test model configuration inline",
      description:
        "Test a model configuration without saving it first. If editing an existing model, pass existingModelId to fall back to its stored API key when apiKey is omitted. Rate limited to 5 requests per minute. Admin only.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["api", "baseUrl", "modelId"],
              properties: {
                api: { type: "string", description: "API type" },
                baseUrl: { type: "string", format: "uri", description: "Provider API base URL" },
                modelId: { type: "string", description: "Model identifier" },
                apiKey: { type: "string", description: "API key (required for new models)" },
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
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TestResult" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "429": { description: "Rate limited" },
      },
    },
  },
  "/api/models/{modelId}": {
    put: {
      operationId: "updateModel",
      tags: ["Models"],
      summary: "Update a custom model",
      description:
        "Update a custom model configuration. Built-in models cannot be modified. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "modelId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                label: { type: "string" },
                api: { type: "string" },
                baseUrl: { type: "string", format: "uri" },
                modelId: { type: "string" },
                apiKey: { type: "string" },
                enabled: { type: "boolean" },
                input: { type: "array", items: { type: "string" } },
                contextWindow: { type: "integer" },
                maxTokens: { type: "integer" },
                reasoning: { type: "boolean" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Model updated",
          content: {
            "application/json": {
              schema: { type: "object", properties: { id: { type: "string" } } },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    delete: {
      operationId: "deleteModel",
      tags: ["Models"],
      summary: "Delete a custom model",
      description: "Delete a custom model. Built-in models cannot be deleted. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "modelId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Model deleted" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/models/{modelId}/test": {
    post: {
      operationId: "testModel",
      tags: ["Models"],
      summary: "Test model connection",
      description:
        "Test that the model's API key and base URL are valid by making a lightweight request to the provider. Rate limited to 5 requests per minute. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "modelId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Test result",
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
        "429": { description: "Rate limited" },
      },
    },
  },
} as const;
