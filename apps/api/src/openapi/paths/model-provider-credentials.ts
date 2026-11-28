// SPDX-License-Identifier: Apache-2.0

import { MODEL_CREDENTIAL_OWNERS } from "@appstrate/core/model-payer";
import { MODEL_INPUT_MODALITIES } from "@appstrate/core/module";
import { STD_RESPONSE_HEADERS, REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

export const modelProviderCredentialsPaths = {
  "/api/model-provider-credentials/registry": {
    get: {
      operationId: "listModelProviderRegistry",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Model Provider Credentials"],
      summary: "List the in-code model provider registry",
      description:
        "Returns the catalog of LLM providers Appstrate knows how to talk to. The UI uses this to render the provider picker without hard-coding the catalog client-side. Supports offset pagination (`limit`/`offset`) and a `fields` projection selector — request `?fields=providerId,authMode` to skip the heavy per-provider `models` catalog (the bulk of the payload) when you only need to know which providers exist. **Permission:** `model-provider-credentials:read` or `:connect`.",
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
            "Comma-separated allowlist of fields to return per provider (`providerId` is always included). Allowed: providerId, displayName, iconUrl, description, docsUrl, apiShape, defaultBaseUrl, baseUrlOverridable, authMode, featured, live_model_search, models. An unknown field is a 400.",
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
                      // `maxTokens`, `cacheRead`, `cacheWrite`, `tiers`,
                      // `inputTokensAbove`) are the 4e carve-out names of
                      // `docs/CASING_CONVENTIONS.md`, camelCase on the wire; any
                      // other field (`live_model_search`) is snake_case.
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
                        live_model_search: {
                          type: "boolean",
                          description:
                            "The provider serves more models than `models` lists: they are searched live on the provider (`GET /api/models/openrouter`) and any model id is accepted, not only the listed ones.",
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
                              "generation",
                              "cost",
                              "featured",
                            ],
                            properties: {
                              id: { type: "string" },
                              label: {
                                type: "string",
                                description: "Human-readable label — the registry record's name.",
                              },
                              contextWindow: { type: "integer" },
                              maxTokens: { type: ["integer", "null"] },
                              capabilities: { type: "array", items: { type: "string" } },
                              generation: {
                                $ref: "#/components/schemas/ModelGenerationCapabilities",
                              },
                              cost: {
                                type: ["object", "null"],
                                description:
                                  "Per-1M-token cost (USD); null when the registry leaves the model unpriced.",
                                properties: {
                                  input: { type: "number" },
                                  output: { type: "number" },
                                  cacheRead: { type: "number" },
                                  cacheWrite: { type: "number" },
                                  tiers: {
                                    type: "array",
                                    items: { $ref: "#/components/schemas/ModelCostTier" },
                                  },
                                },
                              },
                              featured: {
                                type: "boolean",
                                description:
                                  "Surface in the picker's 'Featured' group for this provider AND auto-seed in `org_models` on first connection. True when the model id appears in the provider's pinned `featuredModels` list; the rest of the offer falls under 'All models'.",
                              },
                              subscription_unverified: {
                                type: "boolean",
                                enum: [true],
                                description:
                                  "Present and `true` on a model of a subscription (OAuth) provider that comes from the live catalog, not from the registry bundled with the platform's agent SDK: the platform builds its request offline, but whether the provider serves it to this subscription is not established. A provider may refuse it at first use, for instance for the client version the SDK announces. Absent otherwise.",
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
        "400": {
          $ref: "#/components/responses/ValidationError",
          description:
            "A `limit`, or an `offset` where the list takes one, outside its declared range (`param` names it), or an unknown `fields` entry.",
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/model-provider-credentials": {
    get: {
      operationId: "listModelProviderCredentials",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Model Provider Credentials"],
      summary: "List model provider credentials",
      description:
        "Returns the LLM model provider credentials (API-key + OAuth alike) of the current organization. Plaintext keys / OAuth tokens are never exposed. **Permission:** `model-provider-credentials:read` lists every credential of the organization; a caller holding only `model-provider-credentials:connect` lists their own personal credentials and no organization or built-in one. Each credential carries its owner (`owner_type`, `owner_id`, `owner_name`).",
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
                    base_url: "https://api.openai.com",
                    source: "custom",
                    authMode: "api_key",
                    owner_type: "org",
                    owner_id: null,
                    owner_name: null,
                    allowed_actions: ["edit", "delete", "test"],
                    config_id: "0f1e2d3c-4b5a-4968-8776-655443322110",
                    serves_model_ids: [],
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
        "403": {
          description:
            "Forbidden — caller holds neither `model-provider-credentials:read` nor `model-provider-credentials:connect`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
    post: {
      operationId: "createModelProviderCredential",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Model Provider Credentials"],
      summary: "Create a model provider credential",
      description:
        "Create a new LLM model provider credential. The plaintext API key is encrypted at rest under a versioned envelope. **Permission:** `model-provider-credentials:write` for an organization credential (`owner_type: org`, the default); `model-provider-credentials:connect` for a personal credential (`owner_type: user`), which belongs to the caller and serves only their own calls. The connection joins a model configuration (`config_id`, else its provider's family configuration, which only a caller holding `models:write` creates when it is missing: `409 model_config_required` otherwise). A personal connection is refused with `403 personal_connections_disabled` when that configuration does not allow personal connections.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["providerId", "api_key"],
              properties: {
                label: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Display name for the model provider credential. Optional — when omitted the server derives one from the provider's `displayName`, prefixed with the configuration's endpoint host for a gateway configuration. Either way it is deduped against existing org credentials.",
                },
                providerId: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Canonical registry providerId (`openai`, `anthropic`, `openai-compatible`, …). Discovered via `GET /api/model-provider-credentials/registry`. Only providers with `authMode: api_key` are accepted here; OAuth providers go through the pairing flow.",
                },
                api_key: {
                  type: "string",
                  minLength: 1,
                  description: "API key for authentication",
                },
                config_id: {
                  type: "string",
                  format: "uuid",
                  description:
                    "The model configuration the connection joins (`GET /api/model-configs`); its endpoint is the connection's. Absent: the provider's family configuration, created when missing for a caller who holds `models:write` (`409 model_config_required` otherwise) — refused (`400`, param `config_id`) for a gateway provider (`baseUrlOverridable: true`), whose endpoint a configuration chooses. A provider that does not fit the configuration is `400 connection_provider_mismatch`; a personal connection to a configuration that does not allow them is `403 personal_connections_disabled`.",
                },
                owner_type: {
                  type: "string",
                  enum: [...MODEL_CREDENTIAL_OWNERS],
                  default: "org",
                  description:
                    "`org` (default) creates an organization credential; `user` creates a personal credential owned by the caller.",
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
            "Bad request — `validation_failed` when the body fails Zod validation, or `invalid_request` when `providerId` is unknown or refers to an OAuth-only provider (use the pairing flow instead). `config_id` (param) when it is absent for a gateway provider; `connection_provider_mismatch` when the provider does not fit the named configuration.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "Forbidden — caller lacks `model-provider-credentials:write` (organization credential) or `model-provider-credentials:connect` (`owner_type: user`), or `personal_connections_disabled` — the configuration does not allow personal connections.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "404": {
          description: "Not found — `config_id` names no model configuration of this organization.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "409": {
          description:
            "`model_config_required` (param `config_id`) — no `config_id` was given, the organization has no configuration for the provider's family, and the caller does not hold `models:write`, the only grant that creates one.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/model-provider-credentials/test": {
    post: {
      operationId: "testModelProviderCredentialInline",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Model Provider Credentials"],
      summary: "Test model provider credential configuration inline",
      description:
        "Test a model provider credential configuration without saving it first. If editing an existing credential, pass its `credentialId`: its provider, API shape and base URL are used, and its stored API key when `api_key` is omitted. `base_url` must then equal the credential's, unless the caller holds `model-provider-credentials:write` and supplies `api_key` for a provider accepting a base URL override (the owner of a personal connection cannot point it at another endpoint); a built-in (system) credential is refused with 403, and a personal credential with `403 personal_connections_disabled` while its model configuration does not allow personal connections. Without a stored credential, the provider's own API shape is used. A gateway provider (one accepting a base URL override) is probed at the endpoint of a stored configuration of the organization (`config_id`, whose provider must fit); a free `base_url` instead is accepted only from a caller holding `model-provider-credentials:write`, and a gateway with neither is `400` (param `config_id`). Any other provider is probed at its default `base_url`, which may be omitted. The test follows the provider's definition: a provider whose model listing is unauthenticated is tested with one minimal chat completion instead of `GET <base_url>/models`. **Permission:** `model-provider-credentials:read` or `:connect`; a `credentialId` the caller may not use answers `404`. Rate limited to 5 requests per minute.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["providerId"],
              properties: {
                providerId: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Registry id of the provider being configured. Unknown ids are rejected with 400.",
                },
                base_url: {
                  type: "string",
                  format: "uri",
                  description:
                    "Model provider API base URL. For a gateway without a stored credential, only a caller holding `model-provider-credentials:write` may set it; never together with `config_id`.",
                },
                config_id: {
                  type: "string",
                  format: "uuid",
                  description:
                    "The model configuration (`GET /api/model-configs`) whose endpoint a draft key is probed at; its provider must fit `providerId`. Unknown for this organization: `404`.",
                },
                api_key: {
                  type: "string",
                  description: "API key (required for new credentials)",
                },
                credentialId: {
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
        "400": {
          $ref: "#/components/responses/ValidationError",
          description: "Validation error.",
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/InternalServerError" },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
  },
  "/api/model-provider-credentials/discover": {
    post: {
      operationId: "discoverModelProviderCredentialModels",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Model Provider Credentials"],
      summary: "Enumerate the models an endpoint serves",
      description:
        "Asks an endpoint for its model listing (`GET <base_url>/models`) and returns the ids it serves, each described with a context window, max output tokens, input modalities and reasoning support. Those come from the listing body itself when the server publishes them per entry (vLLM `max_model_len`, Mistral `capabilities`, OpenRouter `context_length` / `architecture` / `supported_parameters`, LM Studio `max_context_length`) — read from the response already in hand, nothing else is requested — and from the model catalog (Pi's pinned registry) otherwise; `source` says which described a given model. `label` always comes from the catalog. It works BEFORE a credential exists — the operator supplies `providerId` + `api_key` inline, or names a stored `credentialId` — and it **persists nothing**: no credential is created (the probe itself is recorded in the audit trail, without the key). Per-token cost is deliberately never returned: an endpoint serving a vendor's model id is not billed at the vendor's rate. A provider declaring a static model list (every subscription/OAuth provider) is refused — its token is never read or spent to enumerate models. A provider whose listing is unauthenticated has its key checked first by one minimal chat completion, so a rejected key answers `auth_failed` instead of a listing it did not unlock. A listing that declares a next page (Anthropic `has_more` / `last_id`, Google `nextPageToken`) is followed to its end, so a paginated endpoint is enumerated whole; `truncated` says when a page or model cap stopped the read instead; a page whose body streams past the size budget is refused as `bad_response`. Rate limited to 6 requests per minute.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              description:
                "Exactly one of the two forms: `credentialId` alone, or `providerId` + `api_key` (+ optional `config_id` for a stored configuration's endpoint, or `base_url` for a gateway's draft endpoint). Both forms together, or neither, is a 400.",
              properties: {
                credentialId: {
                  type: "string",
                  format: "uuid",
                  description:
                    "An existing organization credential to enumerate. Built-in/system credentials are refused (`operation_not_allowed`).",
                },
                providerId: {
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
                config_id: {
                  type: "string",
                  format: "uuid",
                  description:
                    "A stored model configuration whose endpoint to enumerate; the provider must fit it. Exclusive with `base_url`.",
                },
                base_url: {
                  type: "string",
                  format: "uri",
                  description:
                    "A draft endpoint, for a gateway provider (`baseUrlOverridable: true`) not configured yet; defaults to the provider's `defaultBaseUrl`.",
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
                        "endpoint_capabilities",
                      ],
                      properties: {
                        id: { type: "string", description: "Model id exactly as served." },
                        label: { type: ["string", "null"] },
                        context_window: { type: ["integer", "null"] },
                        max_tokens: { type: ["integer", "null"] },
                        input: {
                          type: ["array", "null"],
                          items: { type: "string", enum: [...MODEL_INPUT_MODALITIES] },
                          description: "Accepted input modalities.",
                        },
                        reasoning: { type: ["boolean", "null"] },
                        source: {
                          type: ["string", "null"],
                          enum: ["endpoint", "catalog", null],
                          description:
                            "Where the description came from: `endpoint` when the listing published at least one of these fields for this model, `catalog` on a pure catalog hit, `null` when neither described it.",
                        },
                        endpoint_capabilities: {
                          type: "object",
                          additionalProperties: false,
                          description:
                            "Capabilities explicitly published by the endpoint, suitable for persisting as model overrides. Omitted fields are unknown to the endpoint listing; the top-level description may fill them from a catalog for display only.",
                          properties: {
                            context_window: { type: "integer", minimum: 1 },
                            max_tokens: { type: "integer", minimum: 1 },
                            input: {
                              type: "array",
                              minItems: 1,
                              items: { type: "string", enum: [...MODEL_INPUT_MODALITIES] },
                            },
                            reasoning: { type: "boolean" },
                          },
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
            "Bad request — `validation_failed` when the body fails Zod validation, or `invalid_request` when both/neither form is supplied, `providerId` is unknown or OAuth-only.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "Forbidden — caller lacks `model-provider-credentials:write` (generic RBAC), or `operation_not_allowed` when `credentialId` refers to a built-in/system credential.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/InternalServerError" },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
  },
  "/api/model-provider-credentials/{id}": {
    patch: {
      operationId: "updateModelProviderCredential",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Model Provider Credentials"],
      summary: "Update a model provider credential",
      description:
        "Update a model provider credential's mutable fields. The `apiShape` and `base_url` of an existing credential are pinned by the canonical `providerId` selected at create time and cannot be changed — delete and re-create the credential to switch providers. Merge semantics (RFC 7396): an absent field is left unchanged, `null` clears a nullable one. **Permission:** `model-provider-credentials:write` for an organization credential; `model-provider-credentials:connect` for a personal credential the caller owns. Another member's personal credential answers `404`.",
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
                api_key: { type: "string", minLength: 1 },
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
        "400": {
          $ref: "#/components/responses/ValidationError",
          description:
            "Validation error. `invalid_request` (param `api_key`) when `api_key` is sent for an OAuth credential: reconnect it instead.",
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "Forbidden — caller lacks `model-provider-credentials:write` (generic RBAC) to change an organization credential, or `operation_not_allowed` when `id` refers to a built-in/system credential that cannot be modified.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "500": { $ref: "#/components/responses/InternalServerError" },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
    delete: {
      operationId: "deleteModelProviderCredential",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Model Provider Credentials"],
      summary: "Delete a model provider credential",
      description:
        "Delete a model provider credential. Its configuration's models stay: they are served by the configuration's other connections, or by none. **Permission:** `model-provider-credentials:delete` for an organization credential; `model-provider-credentials:connect` for a personal credential the caller owns. A holder of `delete` may also delete any member's personal credential (break-glass). Another member's personal credential otherwise answers `404`.",
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
            "Forbidden — caller lacks `model-provider-credentials:delete` (or `connect` on their own personal credential), or `operation_not_allowed` when `id` refers to a built-in/system credential that cannot be deleted.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/model-provider-credentials/{id}/test": {
    post: {
      operationId: "testModelProviderCredential",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Model Provider Credentials"],
      summary: "Test model provider credential connection",
      description:
        "Test that the credential's API key (or OAuth token) and base URL are valid by making a lightweight request to the provider. **Permission:** the caller must see the credential: an organization or built-in credential needs `model-provider-credentials:read`, a personal credential must be the caller's own (anyone else gets `404`). Rate limited to 5 requests per minute.",
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
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
  },
} as const;
