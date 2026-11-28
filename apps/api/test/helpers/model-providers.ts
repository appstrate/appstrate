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
  TEST_PROVIDER_FAMILIES,
} from "./test-oauth-provider.ts";
import { getDiscoveredModules } from "./test-modules.ts";

export interface SeedTestModelProvidersOptions {
  /**
   * Extra module provider ids that keep their production `baseUrlOverridable`
   * value instead of the harness default. Every family head (a provider some
   * other provider names as its `catalogProviderId`, e.g. `openai`, `anthropic`)
   * keeps it already: a gateway configuration only takes connections of its own
   * provider, so a family head turned gateway would refuse its wrappers.
   */
  readonly fixedEndpoint?: readonly string[];
}

export function seedTestModelProviders(options: SeedTestModelProvidersOptions = {}): void {
  resetModelProviders();
  _resetTestOAuthProviderRegistration();
  registerTestOAuthProvider();
  registerTestOAuthHooksProvider();
  registerTestApiKeyProvider();
  // Module-contributed providers are registered with `baseUrlOverridable: true`
  // so the integration harness can point any provider at a mock endpoint
  // (`api.openai.test`, `api.anthropic.test`, …) without each test having to
  // monkey-patch the registry. Providers listed in `fixedEndpoint` keep the
  // production value (`core-providers` ships them `baseUrlOverridable: false`,
  // only `openai-compatible` and `anthropic-compatible` are overridable).
  //
  // A provider another one names as its catalog family (`openai` for `test-oauth`,
  // `anthropic` for `claude-code`) also keeps its production value: a model
  // configuration is stored under the family's provider, and a gateway
  // configuration admits connections of its own provider only, so flipping it
  // would keep every subscription out of its family's configuration.
  const contributions = getDiscoveredModules()
    .map((m) => m.modelProviders?.() ?? [])
    .flat();
  const families = new Set(
    [...TEST_PROVIDER_FAMILIES, ...contributions.map((p) => p.catalogProviderId)].filter(
      (id): id is string => typeof id === "string",
    ),
  );
  const fixedEndpoint = new Set([...(options.fixedEndpoint ?? []), ...families]);
  const moduleContributions = contributions.map((p) =>
    fixedEndpoint.has(p.providerId) ? p : { ...p, baseUrlOverridable: true },
  );
  registerModelProviders(moduleContributions);
}
