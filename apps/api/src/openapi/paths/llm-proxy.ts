// SPDX-License-Identifier: Apache-2.0

/**
 * LLM proxy endpoints — server-side model injection for remote-backed
 * AFPS runs (docs/specs/REMOTE_CLI_EXECUTION_SPEC.md §Phase 3).
 *
 * Three protocol families ship today; each gets its own concrete endpoint
 * so callers hit the upstream shape they already know (OpenAI Chat
 * Completions, Anthropic Messages, Mistral Chat Completions). Additional
 * families land as new path entries — the route surface stays concrete
 * per the spec.
 */

const baseParameters = [
  {
    name: "X-Run-Id",
    in: "header",
    required: false,
    description:
      "Optional run id (`run_…`) to attribute the call to. Populated by " +
      "`appstrate run` once the platform mints a remote run record; rolls " +
      "up into the run's cost/token totals.",
    schema: { type: "string" },
  },
  {
    name: "Idempotency-Key",
    in: "header",
    required: false,
    description:
      "Optional idempotency key; replays are served from the stored " +
      "response for 24h (see Applications idempotency spec).",
    schema: { type: "string", maxLength: 256 },
  },
] as const;

const baseResponses = {
  "200": {
    description:
      "Upstream response forwarded verbatim. For streaming requests " +
      "(`stream: true`), the response is `text/event-stream`; otherwise " +
      "`application/json`.",
    headers: {
      "x-llm-proxy-cache-status": {
        description:
          "Present only when the response cache is enabled (non-streaming " +
          "2xx responses). `MISS` when the upstream was hit and the result " +
          "stored; `HIT` when served from cache.",
        schema: { type: "string", enum: ["HIT", "MISS"] },
      },
    },
    content: {
      // Upstream provider response forwarded verbatim — an arbitrary
      // provider-shaped JSON object (OpenAI/Anthropic/Mistral). Permissive
      // passthrough schema so verify-openapi's "every 2xx JSON declares a
      // schema" gate is satisfied without over-constraining the proxied body.
      "application/json": { schema: { type: "object", additionalProperties: true } },
      "text/event-stream": { schema: { type: "string" } },
    },
  },
  "400": {
    description:
      "Validation error — malformed body, missing/empty `model`, model " +
      "preset not enabled for this org, preset's protocol does not " +
      "match this endpoint (use the corresponding " +
      "`/api/llm-proxy/<api>/…` route instead), the preset's provider is an " +
      "OAuth subscription with no proxyable gateway (connect an API-key " +
      "provider instead), or request body exceeds " +
      "the per-call `LLM_PROXY_LIMITS.max_request_bytes` cap (default 10 MiB).",
  },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": {
    description:
      "Forbidden — principal lacks `llm-proxy:call`, or a non-bearer auth " +
      "method was used (cookie sessions and any unknown/unrecognized auth " +
      "strategy are rejected; bearer only).",
  },
  "413": {
    description:
      "Request body exceeds the global `API_BODY_LIMIT_BYTES` cap (enforced " +
      "by the body-limit middleware).",
  },
  "429": { $ref: "#/components/responses/RateLimited" },
  "502": {
    description:
      "Upstream provider error — the upstream's status and body are " +
      "forwarded verbatim (the documented status may be any non-2xx the " +
      "upstream returns, e.g. 400/401/404/429/500/503). No usage recorded.",
  },
} as const;

export const llmProxyPaths = {
  "/api/llm-proxy/openai-completions/v1/chat/completions": {
    post: {
      operationId: "llmProxyOpenaiChatCompletions",
      tags: ["LLM Proxy"],
      summary: "OpenAI Chat Completions — with server-side model injection",
      description:
        "Wire-compatible with the OpenAI `/v1/chat/completions` endpoint. " +
        "The caller supplies `body.model` as an Appstrate **model preset id** " +
        "(e.g. `m_` or a SYSTEM_PROVIDER_KEYS preset); the platform resolves " +
        "the preset against `org_models` + `model_provider_credentials`, " +
        "substitutes the real upstream model id, injects the upstream API " +
        "key, and forwards the request. Streaming responses pass through " +
        "unchanged; usage is tapped in parallel for accounting.\n\n" +
        "Authentication: bearer only — API key with the `llm-proxy:call` " +
        "scope (headless) or an OIDC-issued JWT (interactive CLI device-flow, " +
        "dashboard access token). Cookie sessions are rejected.",
      security: [{ bearerApiKey: [] }, { bearerJwt: [] }],
      parameters: baseParameters,
      requestBody: {
        description:
          "OpenAI Chat Completions payload, with `model` replaced by an " +
          "Appstrate model preset id. All other fields (`messages`, `tools`, " +
          "`stream`, `response_format`, …) pass through untouched.",
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["model", "messages"],
              properties: {
                model: {
                  type: "string",
                  description: "Appstrate model preset id (NOT an upstream model id).",
                },
                messages: { type: "array", items: { type: "object" } },
                stream: { type: "boolean" },
              },
              additionalProperties: true,
            },
          },
        },
      },
      responses: baseResponses,
    },
  },
  "/api/llm-proxy/anthropic-messages/v1/messages": {
    post: {
      operationId: "llmProxyAnthropicMessages",
      tags: ["LLM Proxy"],
      summary: "Anthropic Messages — with server-side model injection",
      description:
        "Wire-compatible with the Anthropic `/v1/messages` endpoint. The " +
        "caller supplies `body.model` as an Appstrate **model preset id**; " +
        "the platform resolves the preset, substitutes the real upstream " +
        "model id, injects the `x-api-key` server-side, and forwards the " +
        "request. `cache_control` blocks, extended-thinking, tool use — all " +
        "pass through untouched. The `anthropic-version` and `anthropic-beta` " +
        "request headers are forwarded to upstream; `anthropic-version` " +
        "defaults to `2023-06-01` when the caller omits it.\n\n" +
        "Streaming responses pass through unchanged; usage is tapped in " +
        "parallel (merging `message_start` + `message_delta` frames) for " +
        "accounting.\n\n" +
        "Authentication: bearer only — API key with the `llm-proxy:call` " +
        "scope (headless) or an OIDC-issued JWT (interactive CLI device-flow, " +
        "dashboard access token). Cookie sessions are rejected.",
      security: [{ bearerApiKey: [] }, { bearerJwt: [] }],
      parameters: [
        ...baseParameters,
        {
          name: "anthropic-version",
          in: "header",
          required: false,
          description: "Forwarded verbatim to upstream. Defaults to `2023-06-01` when omitted.",
          schema: { type: "string" },
        },
        {
          name: "anthropic-beta",
          in: "header",
          required: false,
          description: "Forwarded verbatim to upstream (e.g. `prompt-caching-2024-07-31`).",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        description:
          "Anthropic Messages payload, with `model` replaced by an " +
          "Appstrate model preset id. All other fields (`messages`, `system`, " +
          "`tools`, `stream`, …) pass through untouched.",
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["model", "messages"],
              properties: {
                model: {
                  type: "string",
                  description: "Appstrate model preset id (NOT an upstream model id).",
                },
                messages: { type: "array", items: { type: "object" } },
                system: { oneOf: [{ type: "string" }, { type: "array" }] },
                max_tokens: { type: "integer" },
                stream: { type: "boolean" },
              },
              additionalProperties: true,
            },
          },
        },
      },
      responses: baseResponses,
    },
  },
  "/api/llm-proxy/mistral-conversations/v1/chat/completions": {
    post: {
      operationId: "llmProxyMistralChatCompletions",
      tags: ["LLM Proxy"],
      summary: "Mistral Chat Completions — with server-side model injection",
      description:
        "Wire-compatible with the Mistral `/v1/chat/completions` endpoint. " +
        "Despite the protocol family name (`mistral-conversations`, inherited " +
        "from pi-ai's registry), this endpoint targets Mistral's standard " +
        "OpenAI-compatible chat-completions API — NOT the Beta Conversations " +
        "agentic API at `/v1/conversations`. The caller supplies `body.model` " +
        "as an Appstrate **model preset id**; the platform resolves the " +
        "preset, substitutes the real upstream model id, injects the upstream " +
        "API key as `Authorization: Bearer`, and forwards the request. All " +
        "other fields (`messages`, `tools`, `tool_choice`, `temperature`, " +
        "`stream`, …) pass through untouched.\n\n" +
        "Streaming responses pass through unchanged; usage is tapped in " +
        "parallel for accounting when the caller opts in (terminal SSE frame " +
        "with `usage`, same convention as OpenAI).\n\n" +
        "Authentication: bearer only — API key with the `llm-proxy:call` " +
        "scope (headless) or an OIDC-issued JWT (interactive CLI device-flow, " +
        "dashboard access token). Cookie sessions are rejected.",
      security: [{ bearerApiKey: [] }, { bearerJwt: [] }],
      parameters: baseParameters,
      requestBody: {
        description:
          "Mistral Chat Completions payload, with `model` replaced by an " +
          "Appstrate model preset id. All other fields pass through untouched.",
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["model", "messages"],
              properties: {
                model: {
                  type: "string",
                  description: "Appstrate model preset id (NOT an upstream model id).",
                },
                messages: { type: "array", items: { type: "object" } },
                stream: { type: "boolean" },
              },
              additionalProperties: true,
            },
          },
        },
      },
      responses: baseResponses,
    },
  },
} as const;
