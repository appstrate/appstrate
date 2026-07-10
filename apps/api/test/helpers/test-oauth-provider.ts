// SPDX-License-Identifier: Apache-2.0

/**
 * Synthetic OAuth model provider used by core integration tests.
 *
 * Core tests exercise the generic OAuth flow (pairing, import, refresh,
 * soft-disable, token resolution) which is platform-owned. Provider
 * definitions are module-owned, so core tests must NOT depend on any
 * specific module's provider — otherwise removing the module would
 * break core tests, violating the zero-footprint invariant.
 *
 * This helper registers a fake `test-oauth` provider directly into the
 * runtime registry. It has the minimum shape (authMode: oauth2 + an
 * `oauth` config block) needed for the OAuth code paths to accept its
 * id; no hooks, no real upstream URLs — tests that need to exercise
 * provider-specific behavior (e.g. JWT identity extraction) belong in
 * that provider's own module test suite.
 */

import type { ModelProviderDefinition } from "@appstrate/core/module";
import { registerModelProvider } from "../../src/services/model-providers/registry.ts";
import { registerCatalog } from "../../src/services/pricing-catalog.ts";

export const TEST_OAUTH_PROVIDER_ID = "test-oauth";

const testOAuthProvider: ModelProviderDefinition = {
  providerId: TEST_OAUTH_PROVIDER_ID,
  displayName: "Test OAuth Provider",
  iconUrl: "openai",
  description: "Synthetic OAuth provider for core integration tests.",
  apiShape: "openai-responses",
  defaultBaseUrl: "https://example.test/v1",
  baseUrlOverridable: false,
  authMode: "oauth2",
  oauth: {
    clientId: "test-client-id",
    authorizationUrl: "https://auth.example.test/authorize",
    tokenUrl: "https://auth.example.test/token",
    refreshUrl: "https://auth.example.test/token",
    scopes: ["openid", "profile"],
    pkce: "S256",
  },
  // Synthetic provider — no catalog, so featured stays empty. The OAuth
  // identity/refresh tests under this fixture don't exercise the picker.
  featuredModels: [],
};

/**
 * Second synthetic provider used to exercise the platform×module hook
 * contracts (`extractTokenIdentity`, `requiredIdentityClaims`, custom
 * `apiShape`) without depending on any real module.
 *
 * The token format this provider's `extractTokenIdentity` understands is
 * deliberately trivial — `accountId:<id>;email:<addr>` — so tests can mint
 * inputs without standing up JWT plumbing.
 */
export const TEST_OAUTH_HOOKS_PROVIDER_ID = "test-oauth-hooks";
export const TEST_OAUTH_HOOKS_BASE_URL = "https://example-hooks.test/api";
export const TEST_OAUTH_HOOKS_API_SHAPE = "openai-responses";

const testOAuthHooksProvider: ModelProviderDefinition = {
  providerId: TEST_OAUTH_HOOKS_PROVIDER_ID,
  displayName: "Test OAuth (with hooks)",
  iconUrl: "openai",
  description: "Synthetic OAuth provider exercising extractTokenIdentity + requiredIdentityClaims.",
  apiShape: TEST_OAUTH_HOOKS_API_SHAPE,
  defaultBaseUrl: TEST_OAUTH_HOOKS_BASE_URL,
  baseUrlOverridable: false,
  authMode: "oauth2",
  oauth: {
    clientId: "test-hooks-client-id",
    authorizationUrl: "https://auth.example-hooks.test/authorize",
    tokenUrl: "https://auth.example-hooks.test/token",
    refreshUrl: "https://auth.example-hooks.test/token",
    scopes: ["openid", "profile"],
    pkce: "S256",
  },
  featuredModels: [],
  requiredIdentityClaims: ["accountId"],
  hooks: {
    extractTokenIdentity(accessToken) {
      const out: { accountId?: string; email?: string } = {};
      for (const part of accessToken.split(";")) {
        const [k, v] = part.split(":");
        if (k === "accountId" && v) out.accountId = v;
        if (k === "email" && v) out.email = v;
      }
      if (!out.accountId && !out.email) return null;
      return out;
    },
  },
};

/** Mint a token consumable by `test-oauth-hooks`'s `extractTokenIdentity`. */
export function mintTestOAuthHooksToken(payload: { accountId?: string; email?: string }): string {
  const parts: string[] = [];
  if (payload.accountId) parts.push(`accountId:${payload.accountId}`);
  if (payload.email) parts.push(`email:${payload.email}`);
  return parts.join(";");
}

/**
 * Synthetic API-key provider. `SYSTEM_PROVIDER_KEYS` entries may only bind
 * providers whose `authMode` is `api-key` — the registry rejects an oauth2
 * binding at boot, because a subscription bearer configured as a static key
 * would be handed to the agent container verbatim. Registry tests that need a
 * resolvable providerId for a static system key therefore seed against THIS
 * provider, not `test-oauth`.
 */
export const TEST_API_KEY_PROVIDER_ID = "test-apikey";

const testApiKeyProvider: ModelProviderDefinition = {
  providerId: TEST_API_KEY_PROVIDER_ID,
  displayName: "Test API Key Provider",
  iconUrl: "openai",
  description: "Synthetic static-API-key provider for core registry tests.",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://example-apikey.test/v1",
  baseUrlOverridable: true,
  authMode: "api_key",
  featuredModels: [],
};

let registered = false;
let hooksRegistered = false;
let apiKeyRegistered = false;

/**
 * Idempotent — safe to call from `beforeEach` / `beforeAll`. The runtime
 * registry de-dupes by providerId, but the second call would throw "duplicate
 * registration" if we called the underlying `registerModelProvider` twice.
 *
 * Also registers a synthetic catalog under `test-oauth` containing one
 * model id (`test-model`) so the `/api/models/seed` route — which
 * validates every requested id against the resolved catalog — accepts
 * the standard test fixture.
 */
export function registerTestOAuthProvider(): void {
  if (registered) return;
  registerModelProvider(testOAuthProvider);
  registerCatalog("test-oauth", {
    "test-model": {
      label: "Test Model",
      contextWindow: 8192,
      maxTokens: 4096,
      capabilities: ["text"],
      cost: { input: 0, output: 0 },
    },
  });
  registered = true;
}

/** Same as {@link registerTestOAuthProvider} for the hooks-bearing variant. */
export function registerTestOAuthHooksProvider(): void {
  if (hooksRegistered) return;
  registerModelProvider(testOAuthHooksProvider);
  hooksRegistered = true;
}

/** Same as {@link registerTestOAuthProvider} for the static-API-key variant. */
export function registerTestApiKeyProvider(): void {
  if (apiKeyRegistered) return;
  registerModelProvider(testApiKeyProvider);
  apiKeyRegistered = true;
}

/**
 * Reset the registration flag — call from a `beforeEach` that also
 * calls `resetModelProviders()`, otherwise the next `register*` call
 * silently no-ops.
 */
export function _resetTestOAuthProviderRegistration(): void {
  registered = false;
  hooksRegistered = false;
  apiKeyRegistered = false;
}
