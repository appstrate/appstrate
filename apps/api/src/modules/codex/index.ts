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
 * deliberately by appending `codex` to MODULES.
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
  ModelProviderDefinition,
  ModelProviderHooks,
} from "@appstrate/core/module";

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
 * Exported off the module for the few hot paths (`token-resolver`,
 * `oauth-flow`, `run-launcher/pi`) that still consume raw claims — once
 * those migrate to `getModelProvider("codex")?.hooks?.extractTokenIdentity`,
 * the export drops.
 */
export function decodeCodexJwtPayload(accessToken: string): {
  chatgpt_account_id?: string;
  email?: string;
} | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1]!;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf-8");
    const claims = JSON.parse(json) as Record<string, unknown>;

    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const accountId =
      auth && typeof auth["chatgpt_account_id"] === "string"
        ? (auth["chatgpt_account_id"] as string)
        : undefined;
    const email = typeof claims["email"] === "string" ? (claims["email"] as string) : undefined;

    return { chatgpt_account_id: accountId, email };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider hooks
// ---------------------------------------------------------------------------

const codexHooks: ModelProviderHooks = {
  /**
   * Read identity claims off the access JWT. The platform persists the
   * result alongside the credential row so the sidecar can build the
   * `chatgpt-account-id` header without re-decoding on every call.
   */
  extractTokenIdentity(accessToken: string): Record<string, string> | null {
    const claims = decodeCodexJwtPayload(accessToken);
    if (!claims) return null;
    const out: Record<string, string> = {};
    if (claims.chatgpt_account_id) out.chatgpt_account_id = claims.chatgpt_account_id;
    if (claims.email) out.email = claims.email;
    return Object.keys(out).length > 0 ? out : null;
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
  forceStream: true,
  forceStore: false,
  authMode: "oauth2",
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
