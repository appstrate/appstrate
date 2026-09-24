// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `resolveCredentialModelIds` — the single accessor every read
 * path uses to answer "which models may this credential serve?".
 *
 * The contract has exactly two halves and they must not blur:
 *
 *   - `modelDiscovery: { mode: "static" }` (subscription sign-ins) — the
 *     persisted column is IGNORED. No probe is ever issued against these
 *     providers (`docs/architecture/SUBSCRIPTION_COMPLIANCE.md`), so the
 *     served set is the provider's offer and a stored copy can only be a
 *     snapshot that rots. The regression that motivated the change is pinned at the bottom
 *     of this file against the real `claude-code` definition.
 *   - every other provider — the persisted column VERBATIM. There the value
 *     is genuinely per-credential (the probe answers against the account's
 *     own plan), so deriving it platform-side would be a fabrication.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveCredentialModelIds } from "../../../src/services/model-providers/credentials.ts";
import { registerModelProvider } from "../../../src/services/model-providers/registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import { listPiModels } from "@appstrate/runner-pi/pi-model";

// Pi's Anthropic records back the synthetic providers.
const CATALOG_ID = "anthropic";
const [M_ONE, M_TWO] = ["claude-opus-5", "claude-sonnet-5"] as const;
const OFFER = listPiModels(CATALOG_ID, "anthropic-messages").map((m) => m.id);
const STATIC_PROVIDER = "test-credential-static";
const PROBE_PROVIDER = "test-credential-probe";

beforeAll(() => {
  // Reset the registry to the canonical baseline FIRST, then layer the
  // synthetic providers on top. The root preload
  // (`test/setup/preload.ts`) discovers `apps/api/src/modules/*` AND every
  // `packages/module-*` workspace package — independently of the `MODULES`
  // env var, which only gates the production loader — so the baseline already
  // contains the real `claude-code` and `codex` definitions. Re-registering
  // `claude-code` by hand would throw "already registered" as soon as any
  // earlier file in the shared `bun test` process re-seeded, which is an
  // order-dependent failure waiting to happen. Seeding gives us the same real
  // definitions with no such coupling.
  seedTestModelProviders();
  const base = {
    displayName: "Synthetic",
    iconUrl: "anthropic",
    description: "Synthetic provider for the credential model-id accessor.",
    apiShape: "anthropic-messages",
    defaultBaseUrl: "https://synthetic.example.test",
    baseUrlOverridable: false,
    catalogProviderId: CATALOG_ID,
    featuredModels: [M_ONE],
  } as const;
  registerModelProvider({
    ...base,
    providerId: STATIC_PROVIDER,
    authMode: "api_key",
    modelDiscovery: { mode: "static" },
  });
  registerModelProvider({ ...base, providerId: PROBE_PROVIDER, authMode: "api_key" });
});

afterAll(() => {
  // Drop the synthetic providers again: `bun test` shares one process and the
  // registry rejects duplicate ids, so leaving them behind would break any
  // later file that registers a provider of its own on top of the baseline.
  seedTestModelProviders();
});

describe("resolveCredentialModelIds — static providers", () => {
  it("derives the offer and ignores a stale persisted array", () => {
    expect(resolveCredentialModelIds(STATIC_PROVIDER, [M_TWO])).toEqual(OFFER);
  });

  it("derives the same list from a null column (nothing to fall back to)", () => {
    expect(resolveCredentialModelIds(STATIC_PROVIDER, null)).toEqual(OFFER);
  });
});

describe("resolveCredentialModelIds — probe providers", () => {
  it("returns the persisted column verbatim, including uncatalogued ids", () => {
    // A probe-verified id is served whether or not the catalog knows it —
    // the empirical answer outranks the vendored metadata.
    expect(resolveCredentialModelIds(PROBE_PROVIDER, [M_TWO, "m-absent"])).toEqual([
      M_TWO,
      "m-absent",
    ]);
  });

  it("returns [] for a null column (discovery never ran)", () => {
    expect(resolveCredentialModelIds(PROBE_PROVIDER, null)).toEqual([]);
  });

  it("returns [] for an unregistered provider rather than throwing", () => {
    // A read path must never 500 because a credential outlived its module.
    expect(resolveCredentialModelIds("provider-that-does-not-exist", null)).toEqual([]);
  });
});

/**
 * Runs against the REAL `claude-code` definition (from the baseline registry,
 * see `beforeAll`) on purpose — a synthetic stand-in would keep passing while
 * the shipped list rots, which is the exact failure this pins.
 */
describe("resolveCredentialModelIds — claude-code regression", () => {
  it("resolves a two-generations-old persisted array to the current offer", () => {
    // The production shape: five `claude-code` credentials all carrying the
    // identical, long-stale array. Before this change that array was what the
    // picker and the seed gate read, so users were offered `claude-opus-4-*`
    // months after Anthropic shipped `claude-opus-5` and after the provider
    // definition had already been corrected.
    const stale = "claude-opus-4-7";
    const resolved = resolveCredentialModelIds("claude-code", [stale]);
    // The persisted array is discarded, not widened: the answer is the whole
    // anthropic offer, current generation included.
    expect(resolved).toEqual(OFFER);
    expect(resolved).toContain("claude-opus-5");
  });
});
