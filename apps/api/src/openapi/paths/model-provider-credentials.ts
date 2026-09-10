// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS, REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

export const modelProviderCredentialsPaths = {
  "/api/model-provider-credentials/registry": {
    get: {
      operationId: "listModelProviderRegistry",
      tags: ["Model Provider Credentials"],
      summary: "List the in-code model provider registry",
      description:
        "Returns the catalog of LLM providers Appstrate knows how to talk to. The UI uses this to render the provider picker without hard-coding the catalog client-side. Supports offset pagination (`limit`/`offset`) and a `fields` projection selector — request `?fields=providerId,authMode` to skip the heavy per-provider `models` catalog (the bulk of the payload) when you only need to know which providers exist.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 100 },
        },
        { $ref: "#/components/parameters/Offset" },
        {
          name: "fields",
          in: "query",
          description:
            "Comma-separated allowlist of fields to return per provider (`providerId` is always included). Allowed: providerId, displayName, iconUrl, description, docsUrl, apiShape, defaultBaseUrl, baseUrlOverridable, authMode, featured, models. An unknown field is a 400.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Model provider registry list",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "total", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      // Only `providerId` is guaranteed: this registry list
                      // supports the `?fields=` projection (projectFields forces
                      // `providerId`, drops every other key on request).
                      // CASING: these provider fields (`providerId`,
                      // `displayName`, `iconUrl`, `docsUrl`, `apiShape`,
                      // `defaultBaseUrl`, `baseUrlOverridable`, `authMode`,
                      // `featured`) and the nested model fields (`contextWindow`,
                      // `maxTokens`, `cacheRead`, `cacheWrite`) are camelCase on
                      // the wire, diverging from the snake_case wire default.
                      // This is an in-code vendored registry (module-supplied
                      // `ModelProviderDef`) serialized verbatim; the spec matches
                      // that runtime output (spec==runtime). Intentional — do NOT
                      // rename to snake_case.
                      required: ["providerId"],
                      properties: {
                        providerId: { type: "string" },
                        displayName: { type: "string" },
                        iconUrl: { type: "string" },
                        description: { type: ["string", "null"] },
                        docsUrl: { type: ["string", "null"] },
                        apiShape: {
                          type: "string",
                          enum: [
                            "anthropic-messages",
                            "openai-completions",
                            "openai-responses",
                            "openai-codex-responses",
                            "mistral-conversations",
                            "google-generative-ai",
                            "google-vertex",
                            "azure-openai-responses",
                            "bedrock-converse-stream",
                          ],
                        },
                        defaultBaseUrl: { type: "string" },
                        baseUrlOverridable: { type: "boolean" },
                        authMode: { type: "string", enum: ["api_key", "oauth2"] },
                        featured: {
                          type: "boolean",
                          description:
                            "Surface this provider in the picker's 'Featured' group (above an 'Other' divider). Module-supplied metadata; never gates writes — any registry entry stays selectable.",
                        },
                        models: {
                          type: "array",
                          items: {
                            type: "object",
                            required: [
                              "id",
                              "label",
                              "contextWindow",
                              "capabilities",
                              "cost",
                              "featured",
                            ],
                            properties: {
                              id: { type: "string" },
                              label: {
                                type: "string",
                                description:
                                  "Human-readable label, derived from the id at vendoring time.",
                              },
                              contextWindow: { type: "integer" },
                              maxTokens: { type: ["integer", "null"] },
                              capabilities: { type: "array", items: { type: "string" } },
                              generation: {
                                $ref: "#/components/schemas/ModelGenerationCapabilities",
                              },
                              cost: {
                                type: "object",
                                description: "Per-1M-token cost (USD).",
                                properties: {
                                  input: { type: "number" },
                                  output: { type: "number" },
                                  cacheRead: { type: "number" },
                                  cacheWrite: { type: "number" },
                                },
                              },
                              featured: {
                                type: "boolean",
                                description:
                                  "Surface in the picker's 'Featured' group for this provider AND auto-seed in `org_models` on first connection. True when the model id appears in the provider's curated `featuredModels` whitelist; the rest of the catalog falls under 'All models'.",
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  total: { type: "integer" },
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
        "Returns all LLM model provider credentials (API-key + OAuth alike) for the current organization. Plaintext keys / OAuth tokens are never exposed.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Model provider credentials list",
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
                    items: { $ref: "#/components/schemas/ModelProviderCredential" },
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
                    apiShape: "openai-completions",
                    baseUrl: "https://api.openai.com",
                    source: "custom",
                    authMode: "api_key",
                    created_by: "usr_cm3abc123",
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
              required: ["providerId", "apiKey"],
              properties: {
                label: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Display name for the model provider credential. Optional — when omitted the server derives one from the provider's `displayName`, prefixed with the endpoint host (`localhost:11434 · OpenAI-compatible (custom)`) when `baseUrlOverride` is supplied to a `baseUrlOverridable` provider. Either way it is deduped against existing org credentials.",
                },
                providerId: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Canonical registry providerId (`openai`, `anthropic`, `openai-compatible`, …). Discovered via `GET /api/model-provider-credentials/registry`. Only providers with `authMode: api_key` are accepted here; OAuth providers go through the pairing flow.",
                },
                apiKey: { type: "string", minLength: 1, description: "API key for authentication" },
                baseUrlOverride: {
                  type: ["string", "null"],
                  format: "uri",
                  description:
                    "Optional override for self-hosted endpoints. Honored only by providers with `baseUrlOverridable: true` (e.g. `openai-compatible`); ignored otherwise.",
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
            "Model provider credential created — the bare created credential resource (same non-secret shape as `GET`/`list`). The api key / OAuth token is never echoed back.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ModelProviderCredential" },
            },
          },
        },
        "400": {
          description:
            "Bad request — `validation_failed` when the body fails Zod validation, or `invalid_request` when `providerId` is unknown or refers to an OAuth-only provider (use the pairing flow instead).",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description: "Forbidden — caller lacks `model-provider-credentials:write`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "500": { $ref: "#/components/responses/InternalServerError" },
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
              required: ["apiShape", "baseUrl"],
              properties: {
                apiShape: {
                  type: "string",
                  minLength: 1,
                  description: "Wire format / API shape",
                },
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
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/model-provider-credentials/discover": {
    post: {
      operationId: "discoverModelProviderCredentialModels",
      tags: ["Model Provider Credentials"],
      summary: "Enumerate the models an endpoint serves",
      description:
        "Asks an endpoint for its model listing (`GET <base_url>/models`) and returns the ids it serves, each described with a context window, max output tokens, input modalities and reasoning support. Those come from the listing body itself when the server publishes them per entry (vLLM `max_model_len`, Mistral `capabilities`, OpenRouter `context_length` / `architecture` / `supported_parameters`, LM Studio `max_context_length`) — read from the response already in hand, nothing else is requested — and from the vendored pricing catalog otherwise; `source` says which described a given model. `label` always comes from the catalog. Unlike `POST /{id}/refresh-models` this works BEFORE a credential exists — the operator supplies `provider_id` + `api_key` inline — and it **persists no model state**: no credential is created, no `available_model_ids` is written (the probe itself is recorded in the audit trail, without the key). Per-token cost is deliberately never returned: an endpoint serving a vendor's model id is not billed at the vendor's rate. A provider declaring a static model list (every subscription/OAuth provider) is refused — its token is never read or spent to enumerate models. A listing that declares a next page (Anthropic `has_more` / `last_id`, Google `nextPageToken`) is followed to its end, so a paginated endpoint is enumerated whole; `truncated` says when a page or model cap stopped the read instead; a page whose body streams past the size budget is refused as `bad_response`. Rate limited to 6 requests per minute.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              description:
                "Exactly one of the two forms: `credential_id` alone, or `provider_id` + `api_key` (+ optional `base_url_override`). Both forms together, or neither, is a 400.",
              properties: {
                credential_id: {
                  type: "string",
                  format: "uuid",
                  description:
                    "An existing organization credential to enumerate. Built-in/system credentials are refused (`operation_not_allowed`).",
                },
                provider_id: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Canonical registry providerId (`openai-compatible`, `openai`, …). Discovered via `GET /api/model-provider-credentials/registry`.",
                },
                api_key: {
                  type: "string",
                  minLength: 1,
                  description:
                    "API key for the endpoint. Used for this one request and never stored or echoed back.",
                },
                base_url_override: {
                  type: "string",
                  format: "uri",
                  description:
                    "Endpoint base URL. Accepted only for providers with `baseUrlOverridable: true`; defaults to the provider's `defaultBaseUrl`.",
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
            "Listing outcome. `models` is empty unless `outcome` is `ok`; every metadata field is null (and `source` is null) when neither the listing nor a catalog described the id. `truncated` marks a list that is short of what the endpoint serves.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["outcome", "models", "truncated", "message"],
                properties: {
                  outcome: {
                    type: "string",
                    enum: [
                      "ok",
                      "auth_failed",
                      "rate_limited",
                      "blocked_url",
                      "unreachable",
                      "bad_response",
                      "http_error",
                    ],
                    description:
                      "`ok` — the endpoint answered with a readable listing. `auth_failed` — 401/403. `rate_limited` — 429. `blocked_url` — the base URL targets a blocked network (SSRF guard, no request sent). `unreachable` — timeout, DNS/TCP/TLS failure or refused redirect. `bad_response` — the body is not JSON or not a listing. `http_error` — any other non-2xx.",
                  },
                  models: {
                    type: "array",
                    items: {
                      type: "object",
                      required: [
                        "id",
                        "label",
                        "context_window",
                        "max_tokens",
                        "input",
                        "reasoning",
                        "source",
                      ],
                      properties: {
                        id: { type: "string", description: "Model id exactly as served." },
                        label: { type: ["string", "null"] },
                        context_window: { type: ["integer", "null"] },
                        max_tokens: { type: ["integer", "null"] },
                        input: {
                          type: ["array", "null"],
                          items: { type: "string" },
                          description: "Accepted input modalities (`text`, `image`).",
                        },
                        reasoning: { type: ["boolean", "null"] },
                        source: {
                          type: ["string", "null"],
                          enum: ["endpoint", "catalog", null],
                          description:
                            "Where the description came from: `endpoint` when the listing published at least one of these fields for this model, `catalog` on a pure catalog hit, `null` when neither described it.",
                        },
                      },
                    },
                  },
                  truncated: {
                    type: "boolean",
                    description:
                      "`true` when the endpoint had more models to declare and a safety cap stopped the read (more than 1000 models, more than 10 listing pages, or a listing that declares a next page without publishing a cursor to follow). The ids returned are then a prefix of what the endpoint serves, not the whole of it. Always `false` for a non-`ok` outcome.",
                  },
                  message: {
                    type: ["string", "null"],
                    description:
                      'Human-readable detail for a non-`ok` outcome (e.g. "URL targets a blocked network"); null on `ok`.',
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "Bad request — `validation_failed` when the body fails Zod validation, or `invalid_request` when both/neither form is supplied, `provider_id` is unknown or OAuth-only, or `base_url_override` is sent to a provider that does not accept one.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "Forbidden — caller lacks `model-provider-credentials:write` (generic RBAC), or `operation_not_allowed` when `credential_id` refers to a built-in/system credential.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/model-provider-credentials/{id}": {
    put: {
      operationId: "updateModelProviderCredential",
      tags: ["Model Provider Credentials"],
      summary: "Update a model provider credential",
      description:
        "Update a model provider credential's mutable fields. The `apiShape` and `baseUrl` of an existing credential are pinned by the canonical `providerId` selected at create time and cannot be changed — delete and re-create the credential to switch providers.",
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
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Model provider credential updated — the bare updated credential resource (same non-secret shape as `GET`/`list`). The api key / OAuth token is never echoed back.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ModelProviderCredential" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "Forbidden — caller lacks `model-provider-credentials:write` (generic RBAC), or `operation_not_allowed` when `id` refers to a built-in/system credential that cannot be modified.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
    delete: {
      operationId: "deleteModelProviderCredential",
      tags: ["Model Provider Credentials"],
      summary: "Delete a model provider credential",
      description:
        "Delete a model provider credential. Returns 409 with `credential_in_use` if any `org_models` row still references it (FK ON DELETE RESTRICT) — detach the model first.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Model provider credential deleted",
          headers: REQUEST_ID_ONLY_HEADERS,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "Forbidden — caller lacks `model-provider-credentials:write` (generic RBAC), or `operation_not_allowed` when `id` refers to a built-in/system credential that cannot be deleted.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "409": {
          description: "Credential is still referenced by one or more models (credential_in_use)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
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
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TestResult" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/model-provider-credentials/{id}/refresh-models": {
    post: {
      operationId: "refreshModelProviderCredentialModels",
      tags: ["Model Provider Credentials"],
      summary: "Discover the models this credential serves",
      description:
        "Discovers the models a credential serves. For API-key providers this is empirical: the credential's provider is asked once for its model listing (`GET <base_url>/models`) and the discovery candidates present in that listing are persisted as `available_model_ids`. For `offline`-validation providers (subscription: codex, claude-code) this is a no-op that reports the current list: NO upstream call is made and NOTHING is persisted, because their served set is derived from the provider definition and the pricing catalog on every read. Real per-model availability is validated at the first run on the Pi engine. Synchronous; rate limited to 6 requests per minute. On the listing path an auth failure, an unreadable listing or an empty intersection leaves the previously persisted list untouched.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Discovery outcome + the credential's current verified list",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["outcome", "candidate_count", "available_model_ids"],
                properties: {
                  outcome: {
                    type: "string",
                    enum: ["ok", "auth_failed", "nothing_verified", "no_candidates"],
                    description:
                      "`ok` — list resolved (persisted on the listing path; derived, nothing written, for `offline`-validation providers). `auth_failed` — credential rejected upstream, nothing persisted. `nothing_verified` — the listing could not be read, or no candidate appeared in it; previous list kept. `no_candidates` — provider resolves no discovery candidate.",
                  },
                  candidate_count: {
                    type: "integer",
                    description:
                      "Number of discovery candidates the provider declares, after dedupe and cap — the same meaning on both paths. Not a request count: the listing path spends one request whatever the candidate count, and `offline`-validation providers (codex, claude-code) spend none. Not a count of what is served either: `available_model_ids` carries that.",
                  },
                  available_model_ids: {
                    type: ["array", "null"],
                    items: { type: "string" },
                  },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
} as const;
