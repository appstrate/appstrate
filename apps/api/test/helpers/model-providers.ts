// SPDX-License-Identifier: Apache-2.0

/**
 * Reset + re-seed the runtime model-provider registry to the canonical
 * test baseline. Lives in a dedicated helper (not `app.ts`) so unit
 * tests that only need the seed function don't pay the cost of
 * importing the full Hono app builder + every route module.
 *
 * The baseline has two layers:
 *
 *   1. Synthetic `test-oauth` + `test-oauth-hooks` providers — core
 *      integration tests for the OAuth flow (pairing, import, refresh,
 *      token resolver) seed against THESE providers, not any module's.
 *      The zero-footprint invariant requires that removing a module
 *      never breaks core tests.
 *   2. Every discovered module's `modelProviders()` contribution —
 *      modules can layer their own definitions on top. Module-specific
 *      integration tests live in `<module>/test/integration/`.
 *
 * `bun test` runs the whole suite in a single process (see CLAUDE.md
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
  registerTestOAuthHooksProvider,
  registerTestOAuthProvider,
  _resetTestOAuthProviderRegistration,
} from "./test-oauth-provider.ts";
import { getDiscoveredModules } from "./test-modules.ts";

export function seedTestModelProviders(): void {
  resetModelProviders();
  _resetTestOAuthProviderRegistration();
  registerTestOAuthProvider();
  registerTestOAuthHooksProvider();
  // Module-contributed providers are registered with `baseUrlOverridable: true`
  // so the integration harness can point any provider at a mock endpoint
  // (`api.openai.test`, `api.anthropic.test`, …) without each test having to
  // monkey-patch the registry. In production, `core-providers` ships these
  // entries with `baseUrlOverridable: false` (only the explicit
  // `openai-compatible` entry is overridable) — flipping the flag in tests is
  // strictly a fixture flexibility, the prod registry is untouched.
  const moduleContributions = getDiscoveredModules()
    .map((m) => m.modelProviders?.() ?? [])
    .flat()
    .map((p) => ({ ...p, baseUrlOverridable: true }));
  registerModelProviders(moduleContributions);
}
