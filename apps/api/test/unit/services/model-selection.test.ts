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
 *
 * The id GRAMMAR (`parseModelId` / `compareVersions`) is pinned here too, at
 * the bottom. It is exported because the CI drift gate
 * (`curated-model-drift.test.ts`) needs the same rule, and the one thing that
 * must never happen again is two parsers disagreeing: the second copy had the
 * stronger date detection while the shipped one let `gpt-5-2025-08-07` parse
 * as version `[5, 2025, 8, 7]` and head a featured list.
 */

import { describe, it, expect } from "bun:test";
import {
  compareVersions,
  parseModelId,
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

  it("rejects dated aliases at any family depth", () => {
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
    // Newest of every family first, THEN every second-newest — so the head of
    // the list is breadth across families, not one family's back catalog.
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
  });

  it("features every declared family, one current model each", () => {
    // Four families × `generations: 1` = four ids, and no cap on top. An
    // earlier `limit: 3` truncated the round-robin's fourth slot, which made
    // `claude-fable` structurally unfeaturable — a family that could never
    // surface a model no matter what Anthropic shipped.
    expect(resolveFeaturedModels(claudeCode)).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-fable-5",
    ]);
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

// ---------------------------------------------------------------------------
// The id grammar
// ---------------------------------------------------------------------------

describe("parseModelId", () => {
  it("handles both version conventions", () => {
    // OpenAI dots the minor, Anthropic dashes it — one parser covers both.
    expect(parseModelId("gpt-5.6-sol")).toEqual({ stem: "gpt", version: [5, 6], qualifier: "sol" });
    expect(parseModelId("gpt-5.4-mini")).toEqual({
      stem: "gpt",
      version: [5, 4],
      qualifier: "mini",
    });
    expect(parseModelId("claude-opus-4-8")).toEqual({
      stem: "claude-opus",
      version: [4, 8],
      qualifier: "",
    });
  });

  it("ignores date-stamped snapshot aliases in both conventions", () => {
    // The regression: the shipped parser only looked at the LAST segment for
    // 6+ digits, so every dashed `YYYY-MM-DD` stamp read as a version and
    // outranked the real one.
    expect(parseModelId("gpt-5-2025-08-07")).toBeNull();
    expect(parseModelId("gpt-5.5-2026-04-23")).toBeNull();
    expect(parseModelId("claude-opus-4-20250514")).toBeNull();
    // The stamp behind a qualifier — an alias of `gpt-5.4-mini` wearing a
    // release date, which made the drift gate cry wolf.
    expect(parseModelId("gpt-5.4-mini-2026-03-17")).toBeNull();
  });

  it("ignores ids that carry no version, and ids that start with one", () => {
    expect(parseModelId("gpt-4o")).toBeNull();
    expect(parseModelId("chatgpt-4o-latest")).toBeNull();
    // No stem: nothing to group or compare it against.
    expect(parseModelId("4-mini")).toBeNull();
  });

  it("rejects zero-padded release stamps", () => {
    // A version segment never carries a leading zero; every one of the 61
    // zero-padded segments in the vendored catalogs is a stamp. Without this
    // rule `grok-4-0709` parses as [4, 709] and outranks `grok-4.5`.
    expect(parseModelId("grok-4-0709")).toBeNull();
    expect(parseModelId("gpt-4-0613")).toBeNull();
    expect(parseModelId("gemini-2.0-flash-001")).toBeNull();
  });

  it("keeps an unpadded YYMM stamp as a version (the accepted gap)", () => {
    // `2512` is indistinguishable from a version without a per-vendor rule.
    // Documented as a known gap: it orders its own family newest-first anyway,
    // unlike the stamps above which outranked real versions across families.
    expect(parseModelId("mistral-large-2512")).toEqual({
      stem: "mistral-large",
      version: [2512],
      qualifier: "",
    });
  });
});

describe("compareVersions", () => {
  it("orders a bare major above a dotted minor of the previous one", () => {
    // `claude-opus-5` is newer than `claude-opus-4-8`: a shorter tuple is a
    // fresh major with no minor yet, not an older release.
    expect(compareVersions([5], [4, 8])).toBeGreaterThan(0);
    expect(compareVersions([5, 6], [5, 6])).toBe(0);
    expect(compareVersions([5, 3], [5, 4])).toBeLessThan(0);
  });
});
