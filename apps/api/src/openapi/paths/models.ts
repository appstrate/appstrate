// SPDX-License-Identifier: Apache-2.0

import { MODEL_INPUT_MODALITIES } from "@appstrate/core/module";
import { MAX_TOKEN_USAGE_TIERS } from "@appstrate/afps-shared/token-usage";
import { STD_RESPONSE_HEADERS, REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

export const modelsPaths = {
  "/api/models": {
    get: {
      operationId: "listModels",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Models"],
      summary: "List organization models",
      description:
        "Returns all models (built-in + custom) for the current organization. Each custom model belongs to a model configuration (`config_id`), whose connections serve it. `billed_to` and `needs_reconnection` are computed for the caller: whose connection would serve the caller now.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Model list",
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
                    providerId: "openai",
                    provider_name: "OpenAI",
                    pi_provider: "openai",
                    pi_dialect: { name: "GPT-4o" },
                    apiShape: "openai-responses",
                    base_url: "https://api.openai.com/v1",
                    modelId: "gpt-4o",
                    generation: {
                      temperature: "supported",
                      reasoning: { supported: "unsupported", adaptive: null, levels: {} },
                    },
                    iconUrl: "openai",
                    source: "built-in",
                    enabled: true,
                    is_default: false,
                    needs_reconnection: false,
                    aliased: false,
                    config_id: null,
                    billed_to: "system",
                    contextWindow: 128000,
                    maxTokens: 16384,
                    reasoning: false,
                    created_by: null,
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
      "x-appstrate-space": { kind: "organization" },
      tags: ["Models"],
      summary: "Create a custom model",
      description:
        "Create a new custom LLM model in a model configuration (`config_id`, `GET /api/model-configs`): the configuration's connections serve it. One row per `(config_id, modelId)` — a second create for a pair the organization already holds is refused with `409 model_already_added`, unless it is a managed (`aliased`) model.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["modelId", "config_id"],
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
                config_id: {
                  type: "string",
                  format: "uuid",
                  description:
                    "The model configuration the model belongs to. Its provider decides the catalog and the endpoint; an unknown id is a 404.",
                },
                input: {
                  type: "array",
                  items: { type: "string", enum: [...MODEL_INPUT_MODALITIES] },
                  description: "Supported input types",
                },
                contextWindow: { type: "integer", description: "Context window size in tokens" },
                maxTokens: { type: "integer", description: "Maximum output tokens" },
                reasoning: { type: "boolean", description: "Whether the model supports reasoning" },
                cost: {
                  type: "object",
                  description:
                    "Cost in USD per million tokens (input/output/cacheRead/cacheWrite, optional long-context tiers)",
                  properties: {
                    input: { type: "number" },
                    output: { type: "number" },
                    cacheRead: { type: "number" },
                    cacheWrite: { type: "number" },
                    tiers: {
                      type: "array",
                      maxItems: MAX_TOKEN_USAGE_TIERS,
                      items: { $ref: "#/components/schemas/ModelCostTier" },
                    },
                  },
                  // Closed like the body around it: a stripped `cache_read`
                  // would store a row that bills cache tokens at no rate.
                  additionalProperties: false,
                },
                aliased: {
                  type: "boolean",
                  description:
                    "Managed-model flag. When true, this model's binding (modelId, provider, base_url, capabilities/cost) is not exposed on user-facing surfaces and these fields are null; inference is routed by the platform.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description:
            "Model created — the bare created model resource (same shape as `GET`/`list`).",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgModel" },
            },
          },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description:
            "Validation error. `code` is `model_not_offered` when the configuration's provider restricts models to its catalog offer and `modelId` is outside it.",
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { $ref: "#/components/responses/ModelAlreadyAdded" },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
  },
  "/api/models/apply": {
    post: {
      operationId: "applyModelChoice",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Models"],
      summary: "Apply a configuration's model choice in one transaction",
      description:
        "One write for a configuration's model choice (`config_id`): the models to create (`add`), the ones to switch on (`enable`) and off (`disable`), and the default (`default_model_id`, the `modelId` of a model of this configuration). Applied in that order — the models, the switches on, the default, the switches off — inside ONE transaction: either all of it is written or none. Every entry is checked as its own route would check it (`POST /api/models`, `PATCH /api/models/{id}`, `PUT /api/models/default`); refusals come back together as `400 validation_failed` with one `errors[]` item per entry (`field`: `add.<i>`, `enable.<i>`, `disable.<i>`, `default_model_id`; `code`: that route's own, or `model_not_in_choice` for a model of another configuration), and nothing is written. Connections are added on their own route (`POST /api/model-provider-credentials`, the pairing flow). Requires `models:write`. Accepts `Idempotency-Key`: a retry with the same key and body replays the first response.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["config_id"],
              properties: {
                config_id: {
                  type: "string",
                  format: "uuid",
                  description: "The model configuration the choice applies to.",
                },
                add: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "object",
                    required: ["modelId"],
                    properties: {
                      label: { type: "string", minLength: 1 },
                      modelId: { type: "string", minLength: 1 },
                      input: {
                        type: "array",
                        items: { type: "string", enum: [...MODEL_INPUT_MODALITIES] },
                      },
                      contextWindow: { type: "integer" },
                      maxTokens: { type: "integer" },
                      reasoning: { type: "boolean" },
                      cost: {
                        type: "object",
                        properties: {
                          input: { type: "number" },
                          output: { type: "number" },
                          cacheRead: { type: "number" },
                          cacheWrite: { type: "number" },
                          tiers: {
                            type: "array",
                            maxItems: MAX_TOKEN_USAGE_TIERS,
                            items: { $ref: "#/components/schemas/ModelCostTier" },
                          },
                        },
                        additionalProperties: false,
                      },
                    },
                    additionalProperties: false,
                  },
                },
                enable: { type: "array", maxItems: 200, items: { type: "string", format: "uuid" } },
                disable: {
                  type: "array",
                  maxItems: 200,
                  items: { type: "string", format: "uuid" },
                },
                default_model_id: {
                  type: "string",
                  minLength: 1,
                  description:
                    "The `modelId` of a model of this configuration, created or existing.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "The choice was applied: the configuration, the models created or switched (same shape as `GET`/`list`), and the default set, if any.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "config_id", "models", "default_model_id"],
                properties: {
                  object: { type: "string", enum: ["model_choice"] },
                  config_id: { type: "string", format: "uuid" },
                  models: { type: "array", items: { $ref: "#/components/schemas/OrgModel" } },
                  default_model_id: {
                    type: ["string", "null"],
                    description:
                      "Organization model row ID resolved from the provider modelId in the request and the configuration. Null when this request did not set a default.",
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "422": { $ref: "#/components/responses/IdempotencyConflict" },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
  },
  "/api/models/default": {
    put: {
      operationId: "setDefaultModel",
      "x-appstrate-space": { kind: "organization" },
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
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Default model updated — the bare *effective* default model resource (same shape as `GET`/`list`). When no DB row is flagged, the system-default fallback (if any) is surfaced.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgModel" },
            },
          },
        },
        "204": {
          description:
            "Default cleared and no model remains in effect (no system default configured) — no resource to return.",
          headers: REQUEST_ID_ONLY_HEADERS,
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        // Unknown custom `modelId` (not a system id and no org-owned row) →
        // `setDefaultModel` throws `notFound`. The pointer never silently keeps
        // a stale/absent default.
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "The model cannot become the organization default. `model_disabled` — the row is switched off (`enabled: false`), so model resolution skips it. `model_needs_reconnection` — the organization connection that would serve it can no longer be used for inference: reconnect it first. `model_org_connection_required` — no organization connection of its configuration serves it: the default also serves schedules, API keys and end users, which only an organization connection can pay for.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
  },
  "/api/models/seed": {
    post: {
      operationId: "seedModels",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Models"],
      summary: "Bulk-seed catalog models into a model configuration",
      description:
        "Atomically seed multiple `org_models` rows into a model configuration from its provider's catalog. Idempotent — returns `created: 0` when the configuration already has models.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["config_id", "model_ids"],
              properties: {
                config_id: { type: "string", format: "uuid" },
                model_ids: {
                  type: "array",
                  minItems: 1,
                  maxItems: 50,
                  uniqueItems: true,
                  items: { type: "string", minLength: 1 },
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Models seeded",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["created", "ids", "promoted_default"],
                properties: {
                  created: { type: "integer", minimum: 0 },
                  ids: { type: "array", items: { type: "string" } },
                  promoted_default: { type: "boolean" },
                },
              },
            },
          },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description:
            "Validation error. `code` is `model_not_offered` when one of `model_ids` is outside the provider's catalog offer.",
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
  },
  "/api/models/openrouter": {
    get: {
      operationId: "searchOpenRouterModels",
      "x-appstrate-space": { kind: "organization" },
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
                          items: { type: "string", enum: [...MODEL_INPUT_MODALITIES] },
                          description: "Supported input types",
                        },
                        reasoning: {
                          type: "boolean",
                          description: "Whether model supports reasoning",
                        },
                        cost: {
                          type: ["object", "null"],
                          description:
                            "Cost in USD per million tokens (input/output/cacheRead/cacheWrite), or null when pricing is missing",
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
                    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
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
                type: "https://docs.appstrate.dev/errors/provider-error",
                title: "Bad Gateway",
                status: 502,
                detail: "OpenRouter API returned an unexpected error",
                code: "provider_error",
                request_id: "req_abc123",
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
                type: "https://docs.appstrate.dev/errors/timeout",
                title: "Gateway Timeout",
                status: 504,
                detail: "OpenRouter did not respond within the allowed time",
                code: "timeout",
                request_id: "req_def456",
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
      "x-appstrate-space": { kind: "organization" },
      tags: ["Models"],
      summary: "Test model configuration inline",
      description:
        "Test a model configuration without saving it first by checking its credential. `ok: true` means the credential is usable. The model itself is not part of the check, so `ok: true` does not establish that the provider serves this model with that credential. A subscription credential (OAuth) is validated offline from its token, with no request to the provider (`latency` is 0). An API key is checked with one lightweight request to the provider: its model listing, or, for a provider whose listing answers any key, a minimal completion on a model of the provider's offer. The check uses `api_key` when given, the credential's stored key otherwise. A built-in credential is refused (403). Rate limited to 5 requests per minute.",
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
                api_key: {
                  type: "string",
                  description:
                    "Override API key for the probe. Falls back to the credential's stored key.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Test result",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TestResult" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
  },
  "/api/models/{id}": {
    patch: {
      operationId: "updateModel",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Models"],
      summary: "Update a custom model",
      description:
        "Update a custom model. Built-in models cannot be modified. Merge semantics (RFC 7396): an absent field is left unchanged, `null` clears a nullable one. A model never changes configuration.",
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
                enabled: { type: "boolean" },
                input: {
                  type: ["array", "null"],
                  items: { type: "string", enum: [...MODEL_INPUT_MODALITIES] },
                },
                contextWindow: { type: ["integer", "null"] },
                maxTokens: { type: ["integer", "null"] },
                reasoning: { type: ["boolean", "null"] },
                cost: {
                  type: ["object", "null"],
                  description:
                    "Cost in USD per million tokens (input/output/cacheRead/cacheWrite, optional long-context tiers)",
                  properties: {
                    input: { type: "number" },
                    output: { type: "number" },
                    cacheRead: { type: "number" },
                    cacheWrite: { type: "number" },
                    tiers: {
                      type: "array",
                      maxItems: MAX_TOKEN_USAGE_TIERS,
                      items: { $ref: "#/components/schemas/ModelCostTier" },
                    },
                  },
                  // Closed like the body around it: a stripped `cache_read`
                  // would store a row that bills cache tokens at no rate.
                  additionalProperties: false,
                },
                aliased: {
                  type: "boolean",
                  description:
                    "Managed-model flag. When true, this model's binding is not exposed on user-facing surfaces.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Model updated — the bare updated model resource (same shape as `GET`/`list`). For a managed (aliased) model the binding fields are nulled, exactly as on `list`.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgModel" },
            },
          },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description:
            "Validation error. `code` is `model_not_offered` when the configuration's provider restricts models to its catalog offer and `modelId` is outside it.",
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "`model_already_added` — the update lands on a `modelId` another row of its configuration already holds; the problem body carries `existing_model_id`. `model_disabled` — `enabled: false` was sent for the current organization default: pick another default first, or clear it (`PUT /api/models/default` with `modelId: null`).",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
    delete: {
      operationId: "deleteModel",
      "x-appstrate-space": { kind: "organization" },
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
          headers: REQUEST_ID_ONLY_HEADERS,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/models/{id}/test": {
    post: {
      operationId: "testModel",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Models"],
      summary: "Test model connection",
      description:
        "Test the credential and base URL a saved model is bound to. `ok: true` means the credential is usable. The model itself is not part of the check, so `ok: true` does not establish that the provider serves this model with that credential. A subscription credential (OAuth) is validated offline from its token, with no request to the provider (`latency` is 0). An API key is checked with one lightweight request to the provider: its model listing, or, for a provider whose listing answers any key, a minimal completion on a model of the provider's offer. Rate limited to 5 requests per minute. Not available for a managed (aliased) model: the result would report the hidden backing's round-trip time and upstream status.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Test result",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TestResult" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "404": { $ref: "#/components/responses/NotFound" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description:
            "`model_credential_required` — no organization connection of the model's configuration serves it, so there is nothing of the organization's to test.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
  },
} as const;
