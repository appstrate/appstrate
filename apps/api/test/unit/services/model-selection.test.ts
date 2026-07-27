// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the model-list resolver — the single place a provider
 * definition's declarative `ModelIdSelection` becomes concrete catalog ids.
 *
 * The resolution rules are a contract two subscription providers depend on
 * (`claude-code` derives BOTH its lists from the vendored anthropic catalog),
 * and `docs/architecture/SUBSCRIPTION_COMPLIANCE.md` forbids any upstream
 * probe that could correct a mistake here. So the ordering, the dated-alias
 * rejection and the round-robin are pinned explicitly, plus the real outcome
 * that motivated the work: `claude-code` must surface the current Anthropic
 * generation without anyone editing a list.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveFeaturedModels,
  resolveDiscoveryCandidates,
} from "../../../src/services/model-providers/model-selection.ts";
import { registerCatalog } from "../../../src/services/pricing-catalog.ts";
import claudeCodeModule from "@appstrate/module-claude-code";
import type { CatalogModelEntry } from "@appstrate/shared-types";

const ENTRY: CatalogModelEntry = {
  label: "synthetic",
  contextWindow: 1000,
  maxTokens: 100,
  capabilities: ["text"],
  cost: { input: 0, output: 0 },
};

/**
 * Synthetic catalog exercising every parsing edge in one place: two-segment
 * versions, a bare-major that must outrank them, dated aliases at both family
 * depths, a non-numeric tail, and a family with a single generation.
 */
const SYNTHETIC_PROVIDER = "test-model-selection";
registerCatalog(
  SYNTHETIC_PROVIDER,
  Object.fromEntries(
    [
      "syn-alpha-4-1",
      "syn-alpha-4-5",
      "syn-alpha-4-8",
      "syn-alpha-5",
      "syn-alpha-4-20250514", // dated alias — must never win the ordering
      "syn-alpha-4-5-20251101", // dated alias at family depth 2
      "syn-alpha-preview", // non-numeric tail — not a version
      "syn-beta-2",
      "syn-beta-3",
      "syn-gamma-1",
      "syn-alphabet-9", // shares a prefix with `syn-alpha` but is NOT in it
    ].map((id) => [id, ENTRY]),
  ),
);

/** Minimal definition shape the resolver reads. */
function def(selection: Parameters<typeof resolveFeaturedModels>[0]["featuredModels"]) {
  return { providerId: SYNTHETIC_PROVIDER, featuredModels: selection };
}

describe("resolveFeaturedModels — array selections", () => {
  it("passes an explicit array through unchanged", () => {
    expect(resolveFeaturedModels(def(["b", "a", "c"]))).toEqual(["b", "a", "c"]);
  });

  it("dedupes an explicit array while preserving first-seen order", () => {
    expect(resolveFeaturedModels(def(["a", "b", "a"]))).toEqual(["a", "b"]);
  });

  it("never consults the catalog for an array (ids need not exist)", () => {
    expect(resolveFeaturedModels(def(["not-in-any-catalog"]))).toEqual(["not-in-any-catalog"]);
  });
});

describe("resolveFeaturedModels — catalog selectors", () => {
  it("orders a family newest-first, treating a missing segment as 0", () => {
    // `syn-alpha-5` ([5]) is a fresh major, not an ancestor of `syn-alpha-4-8`
    // ([4, 8]) — the shorter tuple must still win.
    expect(resolveFeaturedModels(def({ catalogFamilies: ["syn-alpha"], generations: 4 }))).toEqual([
      "syn-alpha-5",
      "syn-alpha-4-8",
      "syn-alpha-4-5",
      "syn-alpha-4-1",
    ]);
  });

  it("rejects dated aliases (6+ digit final segment) at any family depth", () => {
    const out = resolveFeaturedModels(def({ catalogFamilies: ["syn-alpha"], generations: 99 }));
    expect(out).not.toContain("syn-alpha-4-20250514");
    expect(out).not.toContain("syn-alpha-4-5-20251101");
    // A date stamp sorts above every real version, so leaking one would put a
    // duplicate snapshot id at the head of the featured list.
    expect(out[0]).toBe("syn-alpha-5");
  });

  it("ignores ids whose tail is not purely numeric, and prefix look-alikes", () => {
    const out = resolveFeaturedModels(def({ catalogFamilies: ["syn-alpha"], generations: 99 }));
    expect(out).not.toContain("syn-alpha-preview");
    expect(out).not.toContain("syn-alphabet-9");
  });

  it("interleaves families round-robin by generation index", () => {
    // Newest of every family first, THEN every second-newest — so a `limit`
    // buys breadth across families instead of one family's back catalog.
    expect(
      resolveFeaturedModels(
        def({ catalogFamilies: ["syn-alpha", "syn-beta", "syn-gamma"], generations: 2 }),
      ),
    ).toEqual([
      "syn-alpha-5",
      "syn-beta-3",
      "syn-gamma-1",
      "syn-alpha-4-8",
      "syn-beta-2",
      // syn-gamma has a single generation — skipped at index 1, not padded.
    ]);
  });

  it("honours `generations` as a per-family cap", () => {
    expect(
      resolveFeaturedModels(def({ catalogFamilies: ["syn-alpha", "syn-beta"], generations: 1 })),
    ).toEqual(["syn-alpha-5", "syn-beta-3"]);
  });

  it("honours `limit` as a hard cap applied after ordering", () => {
    expect(
      resolveFeaturedModels(
        def({ catalogFamilies: ["syn-alpha", "syn-beta", "syn-gamma"], generations: 2, limit: 2 }),
      ),
    ).toEqual(["syn-alpha-5", "syn-beta-3"]);
  });

  it("applies `deny` on exact id before `limit`", () => {
    // Denying the newest promotes the next generation into the capped window
    // rather than shrinking the list — deny must not cost a slot.
    expect(
      resolveFeaturedModels(
        def({
          catalogFamilies: ["syn-alpha"],
          generations: 3,
          limit: 2,
          deny: ["syn-alpha-5"],
        }),
      ),
    ).toEqual(["syn-alpha-4-8", "syn-alpha-4-5"]);
  });

  it("resolves an unknown catalog to [] without throwing", () => {
    expect(
      resolveFeaturedModels({
        providerId: "no-such-catalog",
        featuredModels: { catalogFamilies: ["syn-alpha"], generations: 2 },
      }),
    ).toEqual([]);
  });

  it("resolves a family that matches nothing to []", () => {
    expect(resolveFeaturedModels(def({ catalogFamilies: ["syn-nope"], generations: 2 }))).toEqual(
      [],
    );
  });
});

describe("resolveDiscoveryCandidates", () => {
  it("falls back to the featured selection when candidates are absent", () => {
    expect(
      resolveDiscoveryCandidates({
        providerId: SYNTHETIC_PROVIDER,
        featuredModels: { catalogFamilies: ["syn-beta"], generations: 2 },
      }),
    ).toEqual(["syn-beta-3", "syn-beta-2"]);
  });

  it("prefers the candidate selection over the featured one", () => {
    expect(
      resolveDiscoveryCandidates({
        providerId: SYNTHETIC_PROVIDER,
        featuredModels: { catalogFamilies: ["syn-beta"], generations: 1 },
        modelDiscoveryCandidates: ["explicit-a", "explicit-b"],
      }),
    ).toEqual(["explicit-a", "explicit-b"]);
  });

  it("resolves against `catalogProviderId` when the provider has no own catalog", () => {
    expect(
      resolveDiscoveryCandidates({
        providerId: "some-oauth-flavour",
        catalogProviderId: SYNTHETIC_PROVIDER,
        featuredModels: { catalogFamilies: ["syn-gamma"], generations: 1 },
      }),
    ).toEqual(["syn-gamma-1"]);
  });
});

describe("claude-code against the vendored anthropic catalog", () => {
  const claudeCode = (claudeCodeModule.modelProviders?.() ?? [])[0]!;

  it("features the current Anthropic generation (the rot this fixes)", () => {
    // The hand-curated list topped out at `claude-opus-4-7` months after
    // anthropic.json gained `claude-opus-5` / `claude-sonnet-5`. Deriving
    // makes that class of drift impossible.
    const featured = resolveFeaturedModels(claudeCode);
    expect(featured).toContain("claude-opus-5");
    expect(featured).toContain("claude-sonnet-5");
    expect(featured).toHaveLength(3);
  });

  it("carries three generations per family into discovery candidates", () => {
    const candidates = resolveDiscoveryCandidates(claudeCode);
    // Newest of each family leads (round-robin), previous generations follow.
    expect(candidates.slice(0, 2)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(candidates).toContain("claude-opus-4-8");
    expect(candidates).toContain("claude-sonnet-4-6");
    // Candidates are a superset of featured — a user's plan may serve a
    // previous generation only.
    for (const id of resolveFeaturedModels(claudeCode)) {
      expect(candidates).toContain(id);
    }
    // No dated alias ever reaches `available_model_ids`.
    expect(candidates.every((id) => !/-\d{6,}$/.test(id))).toBe(true);
  });
});
