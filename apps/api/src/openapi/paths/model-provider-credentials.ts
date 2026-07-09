// SPDX-License-Identifier: Apache-2.0

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
        {
          name: "offset",
          in: "query",
          schema: { type: "integer", minimum: 0, default: 0 },
        },
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
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
                    "Display name for the model provider credential. Optional — the server derives one from the provider's `displayName` when omitted, deduping against existing org credentials.",
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
            },
          },
        },
      },
      responses: {
        "201": {
          description:
            "Model provider credential created — the bare created credential resource (same non-secret shape as `GET`/`list`). The api key / OAuth token is never echoed back.",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Model provider credential updated — the bare updated credential resource (same non-secret shape as `GET`/`list`). The api key / OAuth token is never echoed back.",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
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
        "Discovers the models a credential serves and persists them as `available_model_ids`. For `probe`-validation (API-key) providers this is empirical: each discovery candidate is probed against the live credential (1-token inference requests on the account's own quota) and the ids that answered are persisted. For `offline`-validation providers (subscription: codex, claude-code) NO upstream call is made — the provider's static candidate set (intersected with the catalog) is persisted instead; real per-model availability is validated at the first run on the Pi engine. Synchronous; rate limited to 6 requests per minute. An auth failure or an all-failure round leaves the previously persisted list untouched.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Discovery outcome + the credential's current verified list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["outcome", "probed_count", "available_model_ids"],
                properties: {
                  outcome: {
                    type: "string",
                    enum: ["ok", "auth_failed", "nothing_verified", "no_candidates"],
                    description:
                      "`ok` — list persisted. `auth_failed` — credential rejected upstream, nothing persisted. `nothing_verified` — every probe failed (network incident or none served), previous list kept. `no_candidates` — provider declares no discovery candidates.",
                  },
                  probed_count: {
                    type: "integer",
                    description:
                      "Number of candidates considered, not necessarily models live-probed. For `offline`-validation providers (codex, claude-code) candidates are considered with zero upstream calls.",
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
