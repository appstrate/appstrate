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
  models: [
    {
      id: "test-model",
      contextWindow: 8000,
      capabilities: ["text"],
      recommended: true,
    },
  ],
};

let registered = false;

/**
 * Idempotent — safe to call from `beforeEach` / `beforeAll`. The runtime
 * registry de-dupes by providerId, but the second call would throw "duplicate
 * registration" if we called the underlying `registerModelProvider` twice.
 */
export function registerTestOAuthProvider(): void {
  if (registered) return;
  registerModelProvider(testOAuthProvider);
  registered = true;
}

/**
 * Reset the registration flag — call from a `beforeEach` that also
 * calls `resetModelProviders()`, otherwise the next `register*` call
 * silently no-ops.
 */
export function _resetTestOAuthProviderRegistration(): void {
  registered = false;
}
