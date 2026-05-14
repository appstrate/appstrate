// SPDX-License-Identifier: Apache-2.0

/**
 * Codex (ChatGPT) module — OAuth model provider that lets an operator
 * connect their ChatGPT Plus / Pro / Business subscription via the
 * official Codex OAuth client_id.
 *
 * Why a dedicated module: Codex sits in a ToS grey zone (OpenAI's
 * consumer Terms of Use lack an explicit Anthropic-style ban on
 * third-party OAuth tools, but the client_id allowlist + reverse-
 * engineered wire format are policy-fragile). Operators opt in
 * deliberately by appending `@appstrate/module-codex` to MODULES.
 *
 * Provider-specific behaviors live on the definition's `hooks` field:
 *   - `extractTokenIdentity` decodes the RS256 access JWT to surface
 *     `chatgpt_account_id` (required as `chatgpt-account-id` header by
 *     the chatgpt.com Codex backend) and `email`.
 *   - `beforeLlmProxyRequest` is not currently needed — the sidecar
 *     reads the persisted `accountId` from the credential row before
 *     each request, and `forceStream` / `forceStore` are pinned in the
 *     declarative wire-format fields.
 */

import type {
  AppstrateModule,
  InferenceProbeBuildError,
  InferenceProbeContext,
  InferenceProbeRequest,
  ModelProviderDefinition,
  ModelProviderHooks,
  ModelProviderIdentity,
} from "@appstrate/core/module";
import { base64UrlEncode, decodeJwtPayload } from "@appstrate/core/jwt";

// ---------------------------------------------------------------------------
// Codex JWT decoder
// ---------------------------------------------------------------------------

/**
 * Decode the payload of a Codex access token.
 *
 * Codex tokens are RS256 JWTs whose payload contains:
 *   - `https://api.openai.com/auth.chatgpt_account_id` (UUID)
 *   - `email`, `email_verified`
 *   - standard `iss`, `aud`, `exp`, `iat` claims
 *
 * Returns `null` if the token is not a JWT or the payload is malformed.
 * Does NOT verify the signature — the runtime trusts that the OAuth
 * dance produced this token; downstream Codex calls verify it
 * server-side.
 *
 * Module-private — consumers go through `extractTokenIdentity` /
 * `buildApiKeyPlaceholder` on the provider's `hooks`.
 */
function decodeCodexJwtPayload(accessToken: string): {
  chatgpt_account_id?: string;
  email?: string;
} | null {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return null;
  const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const accountId =
    auth && typeof auth["chatgpt_account_id"] === "string"
      ? (auth["chatgpt_account_id"] as string)
      : undefined;
  const email = typeof claims["email"] === "string" ? (claims["email"] as string) : undefined;
  return { chatgpt_account_id: accountId, email };
}

// ---------------------------------------------------------------------------
// Provider hooks
// ---------------------------------------------------------------------------

/**
 * Build the Codex inference probe request. Mirrors pi-ai's openai-codex-
 * responses provider exactly (cf. node_modules/@mariozechner/pi-ai/dist/
 * providers/openai-codex-responses.js). The wire format is the
 * regression-prone part — Codex rejects requests that drop any of the
 * load-bearing headers (`chatgpt-account-id`, `originator`, `OpenAI-Beta`).
 *
 * Module-private — the wire shape is pinned via `buildInferenceProbe`
 * on the provider's `hooks`.
 */
function buildCodexInferenceRequest(config: {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  accountId: string;
}): InferenceProbeRequest {
  return {
    url: `${config.baseUrl.replace(/\/+$/, "")}/codex/responses`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "chatgpt-account-id": config.accountId,
      originator: "pi",
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.modelId,
      store: false,
      stream: true,
      instructions: "ping",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
      include: [],
    }),
  };
}

const codexHooks: ModelProviderHooks = {
  /**
   * Decode the access JWT and map Codex-specific claims into the
   * platform's abstract identity slots:
   *  - `chatgpt_account_id` → `accountId` (echoed by the sidecar as the
   *    `chatgpt-account-id` header at request time)
   *  - `email` → `email`
   *
   * The platform persists the result alongside the credential row so the
   * sidecar doesn't re-decode on every call.
   */
  extractTokenIdentity(accessToken: string): ModelProviderIdentity | null {
    const claims = decodeCodexJwtPayload(accessToken);
    if (!claims) return null;
    const out: ModelProviderIdentity = {};
    if (claims.chatgpt_account_id) out.accountId = claims.chatgpt_account_id;
    if (claims.email) out.email = claims.email;
    return out.accountId || out.email ? out : null;
  },

  /**
   * Build the `MODEL_API_KEY` placeholder the agent container sees. pi-ai's
   * `openai-codex-responses` provider decodes the apiKey as a JWT to read
   * `https://api.openai.com/auth.chatgpt_account_id`, so the placeholder
   * must be a parseable JWT carrying only that claim — anything else
   * either fails to parse or leaks signature material into the container.
   *
   * Returns `null` when the access token has no decodable account id so
   * the platform falls back to its generic dash-stripped placeholder.
   */
  buildApiKeyPlaceholder(accessToken: string): string | null {
    const claims = decodeCodexJwtPayload(accessToken);
    const accountId = claims?.chatgpt_account_id;
    if (!accountId) return null;
    const headerB64 = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
    const payloadB64 = base64UrlEncode(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      }),
    );
    // Fixed, recognisable fake signature — never derived from the real one.
    return `${headerB64}.${payloadB64}.placeholder`;
  },

  /**
   * Build the inference probe sent by the platform's connection test.
   * Codex's chatgpt.com backend exposes no `/models` endpoint, so the
   * generic discovery probe is useless — we issue a real single-token
   * `${baseUrl}/codex/responses` request instead. On 200 the connection
   * works end-to-end (oauth + chatgpt backend + subscription + model).
   *
   * Returns a structured error when the `accountId` slot is missing so
   * the platform fails the test loudly instead of sending a request the
   * backend will 401.
   */
  buildInferenceProbe(
    ctx: InferenceProbeContext,
  ): InferenceProbeRequest | InferenceProbeBuildError | null {
    if (!ctx.accountId) {
      return {
        error: "AUTH_FAILED",
        message: "Missing chatgpt-account-id (token may not be a valid Codex JWT)",
      };
    }
    return buildCodexInferenceRequest({
      baseUrl: ctx.baseUrl,
      modelId: ctx.modelId,
      apiKey: ctx.apiKey,
      accountId: ctx.accountId,
    });
  },
};

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

const codexProvider: ModelProviderDefinition = {
  providerId: "codex",
  displayName: "Codex (ChatGPT)",
  iconUrl: "openai",
  description: "Run agents against your ChatGPT Plus / Pro / Business subscription via Codex.",
  docsUrl: "https://platform.openai.com/docs/guides/codex",
  // pi-ai's `openai-codex-responses` provider builds the request body the
  // chatgpt.com Codex backend actually accepts (`instructions`, `input`,
  // `include` — distinct from the standard openai-responses shape) and
  // resolves the URL to `${baseUrl}/codex/responses` natively. No
  // sidecar-side path rewrite needed.
  apiShape: "openai-codex-responses",
  defaultBaseUrl: "https://chatgpt.com/backend-api",
  baseUrlOverridable: false,
  authMode: "oauth2",
  featured: true,
  oauth: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizationUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    refreshUrl: "https://auth.openai.com/oauth/token",
    scopes: ["openid", "profile", "email"],
    pkce: "S256",
  },
  models: [
    {
      id: "gpt-5.5",
      contextWindow: 200000,
      capabilities: ["text", "image", "reasoning"],
      recommended: true,
    },
    {
      id: "gpt-5.4-mini",
      contextWindow: 200000,
      capabilities: ["text", "reasoning"],
      recommended: true,
    },
    { id: "gpt-5.4", contextWindow: 200000, capabilities: ["text", "reasoning"] },
    { id: "gpt-5.3-codex", contextWindow: 200000, capabilities: ["text", "reasoning"] },
    { id: "gpt-5.2", contextWindow: 200000, capabilities: ["text", "reasoning"] },
  ],
  hooks: codexHooks,
  // The chatgpt.com Codex backend rejects requests without a
  // `chatgpt-account-id` header. The platform refuses to persist a
  // credential whose token doesn't carry this claim — failing at import
  // time is louder than silently persisting a dead credential.
  requiredIdentityClaims: ["accountId"],
  // Sidecar wire-format quirks the chatgpt.com Codex backend enforces:
  //  - `originator: pi` — the only client identifier its allowlist accepts
  //  - `openai-beta: responses=experimental` — gates the Responses surface
  //  - `user-agent: pi (linux x86_64)` — Codex is fronted by Cloudflare,
  //    which bot-mitigates any UA that doesn't look like an approved CLI.
  //    The OpenAI SDK's `OpenAI/JS …` UA triggers `cf-mitigated: challenge`
  //    → HTML 403; pi-ai's `openai-codex-responses` provider sends this
  //    exact string and is verified to pass.
  //  - `accept: text/event-stream` — Codex's `/codex/responses` only
  //    streams; non-SSE requests are rejected.
  oauthWireFormat: {
    identityHeaders: {
      originator: "pi",
      "openai-beta": "responses=experimental",
      "user-agent": "pi (linux x86_64)",
      accept: "text/event-stream",
    },
    accountIdHeader: "chatgpt-account-id",
    forceStream: true,
    forceStore: false,
  },
};

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const codexModule: AppstrateModule = {
  manifest: { id: "codex", name: "Codex (ChatGPT) OAuth Provider", version: "1.0.0" },

  async init() {
    // Declarative — registry pulls from modelProviders() at boot.
  },

  modelProviders() {
    return [codexProvider];
  },
};

export default codexModule;
