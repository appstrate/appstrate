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
 *   - `validateCredential` decodes the same JWT OFFLINE (no network) to
 *     confirm the token is unexpired and carries `chatgpt_account_id`.
 *   - `beforeLlmProxyRequest` is not currently needed — the sidecar
 *     reads the persisted `accountId` from the credential row before
 *     each request.
 *
 * The platform issues ZERO Codex API calls to validate a credential or
 * discover models: validation is the local JWT decode below (inferred from the
 * presence of the `validateCredential` hook), and model discovery persists the
 * static `modelDiscoveryCandidates` (declared via `modelDiscovery: { mode:
 * "static" }`). The user's subscription token is only ever spent via the
 * sidecar's verbatim bearer swap at run time — agent runs execute on the
 * single Pi engine, whose pi-ai SDK emits the codex-responses request
 * shape natively. See
 * `docs/architecture/SUBSCRIPTION_COMPLIANCE.md`.
 */

import type {
  AppstrateModule,
  CredentialValidationContext,
  CredentialValidationResult,
  ModelProviderDefinition,
  ModelProviderHooks,
  ModelProviderIdentity,
} from "@appstrate/core/module";
import { validateOfflineExpiry } from "@appstrate/core/module";
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
  /** Standard `exp` claim — seconds since epoch, when present. */
  exp?: number;
} | null {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return null;
  const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const accountId =
    auth && typeof auth["chatgpt_account_id"] === "string"
      ? (auth["chatgpt_account_id"] as string)
      : undefined;
  const email = typeof claims["email"] === "string" ? (claims["email"] as string) : undefined;
  const exp = typeof claims["exp"] === "number" ? (claims["exp"] as number) : undefined;
  return { chatgpt_account_id: accountId, email, exp };
}

// ---------------------------------------------------------------------------
// Provider hooks
// ---------------------------------------------------------------------------

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
   * Validate a Codex credential OFFLINE — NO request to chatgpt.com. The
   * platform never spends a subscription request to test a token: we
   * decode the access JWT locally and confirm it (a) is a well-formed
   * Codex JWT carrying `chatgpt_account_id` (required as the
   * `chatgpt-account-id` routing header at run time) and (b) has a
   * verifiable, unexpired expiry (the row's `expiresAt` or the token's
   * `exp` claim). When NO expiry source is present, expiry is
   * unverifiable offline and the credential is rejected — a dead token
   * with no expiry metadata must not pass. This is a STRUCTURAL/offline
   * check only (decode + required claims + expiry), NOT a signature
   * verification or a live backend call. Real per-model availability —
   * and true credential liveness — is established at the first agent run
   * (on the Pi engine), which presents the credential to the real backend.
   */
  validateCredential(ctx: CredentialValidationContext): CredentialValidationResult {
    const claims = decodeCodexJwtPayload(ctx.apiKey);
    if (!claims?.chatgpt_account_id) {
      return {
        ok: false,
        error: "AUTH_FAILED",
        message: "Missing chatgpt-account-id (token may not be a valid Codex JWT)",
      };
    }
    // Prefer the credential row's `expiresAt` (the platform's source of
    // truth, kept fresh by the refresh worker); fall back to the token's
    // own `exp` claim (seconds → ms) when the row carries none. The shared
    // gate rejects an absent expiry (unverifiable offline) and a past one.
    const expiresAtMs = ctx.expiresAt ?? (claims.exp !== undefined ? claims.exp * 1000 : undefined);
    return validateOfflineExpiry(expiresAtMs);
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
  // ChatGPT Codex tokens authenticate against the OpenAI catalog —
  // metadata (cost, context, capabilities) flows through openai.json.
  // The subscription backend serves a restricted, moving set of models
  // (no `/models` endpoint to discover it), so this curated list stays
  // the source of truth. The weekly pricing-refresh CI diffs LiteLLM's
  // `chatgpt` provider snapshot
  // (`apps/api/src/data/subscription-watch/chatgpt.json`) — review this
  // list when that snapshot drifts.
  catalogProviderId: "openai",
  // Per https://developers.openai.com/codex/models (ChatGPT sign-in):
  // gpt-5.5, gpt-5.4, gpt-5.4-mini. `gpt-5.3-codex-spark` (Pro-only
  // research preview) is also served but absent from openai.json, so it
  // can't be listed here (boot check). gpt-5.2 / gpt-5.3-codex are
  // deprecated on ChatGPT sign-in.
  featuredModels: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
  // OFFLINE validation: the platform issues ZERO Codex API calls to test
  // a credential or discover models. The connection test runs the
  // `validateCredential` hook below (local JWT decode) — its mere presence is
  // what tells the platform to validate offline. Static discovery persists the
  // candidates below (∩ catalog) without per-model probing. Real availability
  // is checked at the first agent run (on the Pi engine).
  // Persisted as-is (∩ catalog) — what THIS account's plan serves lands on
  // the credential's `available_model_ids`. Superset of `featuredModels`:
  // includes Pro-only previews and recently-deprecated ids so plans that
  // still serve them keep them selectable. Source: featured ∪ LiteLLM's
  // `chatgpt` provider snapshot
  // (apps/api/src/data/subscription-watch/chatgpt.json) — review when the
  // weekly drift PR flags that snapshot.
  modelDiscoveryCandidates: [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-pro",
    "gpt-5.3-codex-spark",
    "gpt-5.3-instant",
    "gpt-5.3-chat-latest",
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
  ],
  // Static discovery: persist the candidates above (∩ catalog) without probing.
  modelDiscovery: { mode: "static" },
  hooks: codexHooks,
  // The chatgpt.com Codex backend rejects requests without a
  // `chatgpt-account-id` header. The platform refuses to persist a
  // credential whose token doesn't carry this claim — failing at import
  // time is louder than silently persisting a dead credential.
  requiredIdentityClaims: ["accountId"],
  // Codex agent runs are EXECUTABLE: they run on the single Pi engine
  // (`@mariozechner/pi-coding-agent`) like any other subscription provider.
  // Pi's SDK (`@mariozechner/pi-ai`) natively emits the codex-responses OAuth
  // request shape (`chatgpt-account-id`, the codex user-agent), so the platform
  // forges nothing — the sidecar `/llm` oauth branch only swaps the placeholder
  // bearer for the real subscription token server-side. There is no
  // per-provider `subscriptionEngine` binding anymore (that field was removed);
  // the run path is provider-neutral. See
  // docs/architecture/SUBSCRIPTION_COMPLIANCE.md.
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
