// SPDX-License-Identifier: Apache-2.0

/**
 * Legacy in-code seed of built-in model providers.
 *
 * Historically the source of truth; now a transitional layer that feeds
 * the runtime registry (`services/model-providers/registry.ts`) at boot.
 * The five built-ins (codex, claude-code, openai, anthropic,
 * openai-compatible) will migrate into proper `core-providers` and
 * `codex` modules in PR 4-5, at which point this file (and the explicit
 * `seedLegacyModelProviders()` call in boot) can be removed.
 *
 * Public re-exports (`getModelProviderConfig`, `listModelProviders`,
 * `isOAuthModelProvider`, `isModelProviderEnabled`,
 * `listEnabledModelProviders`) delegate to the runtime registry so
 * call sites are unchanged during the migration.
 */

import type { ModelProviderDefinition } from "@appstrate/core/module";
import {
  getModelProvider as _getModelProvider,
  isOAuthModelProvider as _isOAuthModelProvider,
  listModelProviders as _listModelProviders,
  isModelProviderEnabled as _isModelProviderEnabled,
  listEnabledModelProviders as _listEnabledModelProviders,
  registerModelProviders,
} from "../model-providers/registry.ts";

// Re-export `ModelProviderDefinition` under the legacy `ModelProviderConfig`
// alias so consumer code in PR 2 keeps compiling. PR 3 sweeps the alias.
export type ModelProviderConfig = ModelProviderDefinition;
export type AuthMode = ModelProviderDefinition["authMode"];
export type ModelEntry = ModelProviderDefinition["models"][number];
export type ModelCapability = ModelEntry["capabilities"][number];
export type ModelCost = NonNullable<ModelEntry["cost"]>;
export type OAuthConfig = NonNullable<ModelProviderDefinition["oauth"]>;

/**
 * Decode the JWT payload of a Codex access token.
 *
 * Codex tokens are RS256 JWTs whose payload contains:
 *   - `https://api.openai.com/auth.chatgpt_account_id` (UUID)
 *   - `email`, `email_verified`
 *   - standard `iss`, `aud`, `exp`, `iat` claims
 *
 * The sidecar needs the account id as a per-request `chatgpt-account-id`
 * header. Returns `null` if the token is not a JWT or the payload is
 * malformed. Does NOT verify the signature — the runtime trusts that the
 * OAuth dance produced this token; downstream Codex calls verify it
 * server-side. Claude Code returns opaque `sk-ant-oat01-…` tokens with no
 * embedded claims, so no Claude equivalent exists.
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

const codexConfig: ModelProviderConfig = {
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
};

/**
 * Claude: `platform.claude.com` is the canonical token host
 * (cf. @mariozechner/pi-ai/utils/oauth/anthropic.js). The first iteration
 * shipped `claude.ai/v1/oauth/token` which appears reachable but returns
 * a non-canonical schema and was the root cause of refresh failures.
 */
const claudeCodeConfig: ModelProviderConfig = {
  providerId: "claude-code",
  displayName: "Claude Code (Anthropic)",
  iconUrl: "anthropic",
  description:
    "Run agents against your Claude Pro / Max / Team subscription via the Claude Code OAuth client.",
  docsUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
  apiShape: "anthropic-messages",
  defaultBaseUrl: "https://api.anthropic.com",
  baseUrlOverridable: false,
  authMode: "oauth2",
  oauth: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizationUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    refreshUrl: "https://platform.claude.com/v1/oauth/token",
    scopes: ["org:create_api_key", "user:profile", "user:inference"],
    pkce: "S256",
  },
  models: [
    {
      id: "claude-opus-4-7",
      contextWindow: 1000000,
      capabilities: ["text", "image", "reasoning", "long-context-1m"],
      recommended: true,
    },
    {
      id: "claude-sonnet-4-6",
      contextWindow: 1000000,
      capabilities: ["text", "image", "reasoning", "long-context-1m"],
      recommended: true,
    },
    {
      id: "claude-haiku-4-5",
      contextWindow: 200000,
      capabilities: ["text", "image"],
    },
  ],
};

/**
 * Built-in provider definitions, in insertion order. Consumed by
 * `seedLegacyModelProviders()` at boot. Each migration to a dedicated
 * module removes the corresponding entry; once empty the file disappears
 * in PR 7.
 *
 * Migration progress:
 *   - openai, anthropic, openai-compatible → `core-providers` module (PR 4 ✅)
 *   - codex → `codex` module (PR 5)
 *   - claude-code → external private module (PR 6 — removed from OSS)
 */
const LEGACY_PROVIDERS: readonly ModelProviderDefinition[] = [
  codexConfig,
  claudeCodeConfig,
];

/**
 * Register every legacy built-in provider into the runtime registry.
 *
 * Called from `boot.ts` AFTER `loadModules()` so that any module-owned
 * provider (when those land) is registered first and a legacy duplicate
 * surfaces as a fatal error rather than a silent shadow.
 */
export function seedLegacyModelProviders(): void {
  registerModelProviders(LEGACY_PROVIDERS);
}

// ---- Back-compat shims (PR 2) -----------------------------------------------
// PR 3 sweeps every caller off these wrappers onto the runtime-registry
// accessors directly. Until then the legacy import paths keep working
// unchanged.

/** @deprecated PR 3 — call `getModelProvider` from `services/model-providers/registry.ts`. */
export function getModelProviderConfig(providerId: string): ModelProviderConfig | null {
  return _getModelProvider(providerId);
}

/** @deprecated PR 3 — import from `services/model-providers/registry.ts`. */
export const isOAuthModelProvider = _isOAuthModelProvider;

/** @deprecated PR 3 — import from `services/model-providers/registry.ts`. */
export const listModelProviders = _listModelProviders;

/** @deprecated PR 3 — import from `services/model-providers/registry.ts`. */
export const isModelProviderEnabled = _isModelProviderEnabled;

/** @deprecated PR 3 — import from `services/model-providers/registry.ts`. */
export const listEnabledModelProviders = _listEnabledModelProviders;

/**
 * @deprecated PR 3 — call `getModelProvider` from the runtime registry.
 *
 * Kept as a freshly-built object literal (not a frozen map) so the legacy
 * `Object.keys(MODEL_PROVIDERS)` boot validation in `boot.ts` keeps
 * working until PR 3 swaps it for `getRegisteredProviderIds()`.
 */
export const MODEL_PROVIDERS: Readonly<Record<string, ModelProviderConfig>> = Object.freeze(
  Object.fromEntries(LEGACY_PROVIDERS.map((p) => [p.providerId, p])),
);
