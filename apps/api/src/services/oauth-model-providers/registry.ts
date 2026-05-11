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

// `decodeCodexJwtPayload` moved into the codex module (PR 5). Re-exported
// here as a temporary back-compat shim so the remaining consumers
// (run-launcher/pi, token-resolver, oauth-flow) keep compiling during PR
// 5. PR 7 deletes this file entirely; each consumer at that point either
// reads the value via `getModelProvider("codex")?.hooks?.extractTokenIdentity?.(token)`
// or imports the codex helper directly.
export { decodeCodexJwtPayload } from "../../modules/codex/index.ts";

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
 * Built-in provider definitions remaining in the legacy seed.
 *
 * Migration progress:
 *   - openai, anthropic, openai-compatible → `core-providers` module (PR 4 ✅)
 *   - codex → `codex` module (PR 5 ✅)
 *   - claude-code → external private module (PR 6 — removed from OSS)
 */
const LEGACY_PROVIDERS: readonly ModelProviderDefinition[] = [claudeCodeConfig];

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
