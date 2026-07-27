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
 *     served set is a pure function of (definition, catalog) and a stored
 *     copy can only be a snapshot that rots. The regression that motivated
 *     the change is pinned at the bottom of this file against the real
 *     `claude-code` definition.
 *   - every other provider — the persisted column VERBATIM. There the value
 *     is genuinely per-credential (the probe answers against the account's
 *     own plan), so deriving it platform-side would be a fabrication.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveCredentialModelIds } from "../../../src/services/model-providers/credentials.ts";
import { registerModelProvider } from "../../../src/services/model-providers/registry.ts";
import { registerCatalog } from "../../../src/services/pricing-catalog.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import claudeCodeModule from "@appstrate/module-claude-code";
import type { CatalogModelEntry } from "@appstrate/shared-types";

const CATALOG_ID = "test-credential-model-ids";
const STATIC_PROVIDER = "test-credential-static";
const PROBE_PROVIDER = "test-credential-probe";

const ENTRY: CatalogModelEntry = {
  label: "synthetic",
  contextWindow: 1000,
  maxTokens: 100,
  capabilities: ["text"],
  cost: { input: 0, output: 0 },
};

beforeAll(() => {
  registerCatalog(CATALOG_ID, { "m-one": ENTRY, "m-two": ENTRY });
  const base = {
    displayName: "Synthetic",
    iconUrl: "anthropic",
    description: "Synthetic provider for the credential model-id accessor.",
    apiShape: "anthropic-messages",
    defaultBaseUrl: "https://synthetic.example.test",
    baseUrlOverridable: false,
    catalogProviderId: CATALOG_ID,
    featuredModels: ["m-one"],
    // "m-absent" is deliberately NOT in the catalog: it pins the ∩-catalog
    // filter, which mirrors the `/seed` route's own membership gate.
    modelDiscoveryCandidates: ["m-one", "m-two", "m-absent"],
  } as const;
  registerModelProvider({
    ...base,
    providerId: STATIC_PROVIDER,
    authMode: "api_key",
    modelDiscovery: { mode: "static" },
  });
  registerModelProvider({ ...base, providerId: PROBE_PROVIDER, authMode: "api_key" });
  // The real `claude-code` provider is NOT in the test `MODULES` list, so
  // registering it here cannot collide. The regression below needs the real
  // definition — a synthetic stand-in would pass while the shipped list rots.
  for (const def of claudeCodeModule.modelProviders?.() ?? []) registerModelProvider(def);
});

afterAll(() => {
  // Restore the canonical baseline: `bun test` shares one process, and the
  // registry rejects duplicate ids, so leaving these behind would break the
  // next file that re-registers a provider.
  seedTestModelProviders();
});

describe("resolveCredentialModelIds — static providers", () => {
  it("derives the list and ignores a stale persisted array", () => {
    expect(resolveCredentialModelIds(STATIC_PROVIDER, ["m-two"])).toEqual(["m-one", "m-two"]);
  });

  it("derives the same list from a null column (nothing to fall back to)", () => {
    expect(resolveCredentialModelIds(STATIC_PROVIDER, null)).toEqual(["m-one", "m-two"]);
  });

  it("never returns a candidate absent from the catalog", () => {
    // Seeding would reject it, so offering it would be a broken promise.
    expect(resolveCredentialModelIds(STATIC_PROVIDER, null)).not.toContain("m-absent");
  });
});

describe("resolveCredentialModelIds — probe providers", () => {
  it("returns the persisted column verbatim, including uncatalogued ids", () => {
    // A probe-verified id is served whether or not the catalog knows it —
    // the empirical answer outranks the vendored metadata.
    expect(resolveCredentialModelIds(PROBE_PROVIDER, ["m-two", "m-absent"])).toEqual([
      "m-two",
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

describe("resolveCredentialModelIds — claude-code regression", () => {
  it("resolves a two-generations-old persisted array to the current catalog generation", () => {
    // The production shape: five `claude-code` credentials all carrying the
    // identical, long-stale array. Before this change that array was what the
    // picker and the seed gate read, so users were offered `claude-opus-4-*`
    // months after Anthropic shipped `claude-opus-5` and after the provider
    // definition had already been corrected.
    const resolved = resolveCredentialModelIds("claude-code", ["claude-opus-4-7"]);
    expect(resolved).toContain("claude-opus-5");
    // The persisted array is not merely widened, it is discarded: the head of
    // the derived list is the newest generation, not what the row happened to
    // record. (`claude-opus-4-7` still appears further down — it is a real
    // catalog member, just no longer the only thing on offer.)
    expect(resolved).not.toEqual(["claude-opus-4-7"]);
    expect(resolved[0]).toBe("claude-opus-5");
  });
});
