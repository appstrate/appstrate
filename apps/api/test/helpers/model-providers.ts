// SPDX-License-Identifier: Apache-2.0

/**
 * Reset + re-seed the runtime model-provider registry to the canonical
 * test baseline. Lives in a dedicated helper (not `app.ts`) so unit
 * tests that only need the seed function don't pay the cost of
 * importing the full Hono app builder + every route module.
 *
 * The baseline has two layers:
 *
 *   1. Synthetic `test-oauth` + `test-oauth-hooks` + `test-apikey`
 *      providers — core integration tests for the OAuth flow (pairing,
 *      import, refresh, token resolver) seed against THESE providers, not
 *      any module's. The zero-footprint invariant requires that removing a
 *      module never breaks core tests. `test-apikey` is the only one a
 *      `SYSTEM_PROVIDER_KEYS` fixture may bind: the registry rejects a
 *      static system key on an `authMode: "oauth2"` provider at boot.
 *   2. Every discovered module's `modelProviders()` contribution —
 *      modules can layer their own definitions on top. Module-specific
 *      integration tests live in `<module>/test/integration/`.
 *
 * `bun test` runs the whole suite in a single process (see AGENTS.md
 * "Testing"), so any test file that legitimately empties the registry
 * to exercise it in isolation MUST call this from its `afterAll` to
 * restore the baseline — otherwise the next file in the run sees an
 * empty registry and every OAuth code path 4xxs on
 * `isOAuthModelProvider()` / `getModelProvider()`.
 */

import {
  registerModelProviders,
  resetModelProviders,
} from "../../src/services/model-providers/registry.ts";
import {
  registerTestApiKeyProvider,
  registerTestOAuthHooksProvider,
  registerTestOAuthProvider,
  _resetTestOAuthProviderRegistration,
} from "./test-oauth-provider.ts";
import { getDiscoveredModules } from "./test-modules.ts";

/** The gateway providers production ships (`core-providers`): the only module ones with a chosen endpoint. */
const GATEWAY_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "openai-compatible",
  "anthropic-compatible",
]);

export function seedTestModelProviders(): void {
  resetModelProviders();
  _resetTestOAuthProviderRegistration();
  registerTestOAuthProvider();
  registerTestOAuthHooksProvider();
  registerTestApiKeyProvider();
  // Module providers keep their production `baseUrlOverridable`: only the two
  // gateway providers take an endpoint per configuration, every other one
  // (openai, anthropic, mistral, codex, …) is a fixed endpoint. A test that
  // needs to reach a mock endpoint creates a gateway configuration on it.
  registerModelProviders(
    getDiscoveredModules()
      .map((m) => m.modelProviders?.() ?? [])
      .flat()
      .map((p) => ({ ...p, baseUrlOverridable: GATEWAY_PROVIDER_IDS.has(p.providerId) })),
  );
}
