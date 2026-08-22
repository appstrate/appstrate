// SPDX-License-Identifier: Apache-2.0

/**
 * The "No pricing" badge exists so a self-hoster learns a model is unpriced
 * BEFORE spending on it. The web test runner has no DOM, so this exercises the
 * pure rule the badge renders (`model-pricing.ts`) — each exclusion on its own,
 * because an exclusion silently dropped is a false positive on every alias or
 * every built-in row — plus source scans proving the page really routes through
 * it instead of restating the condition inline.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isModelUnpriced, type ModelPricingFields } from "../model-pricing.ts";

/** A custom, non-aliased, unpriced row — the one shape that SHOULD flag. */
function model(overrides: Partial<ModelPricingFields> = {}): ModelPricingFields {
  return { source: "custom", aliased: false, cost: null, ...overrides };
}

describe("isModelUnpriced", () => {
  it("a custom model with no rates → flagged", () => {
    // The self-hoster case: an openai-compatible/custom model misses the
    // vendored catalog, so `cost` resolves to null and every run records $0.
    expect(isModelUnpriced(model())).toBe(true);
  });

  it("absent `cost` reads exactly like null (the wire type allows both)", () => {
    // `cost?: {...} | null` — the field can be missing, not just null.
    expect(isModelUnpriced(model({ cost: undefined }))).toBe(true);
  });

  it("a priced model → not flagged", () => {
    expect(isModelUnpriced(model({ cost: { input: 3, output: 15 } }))).toBe(false);
  });

  it("aliased with a null cost → NOT flagged, the false positive the exclusion exists for", () => {
    // `projectAliasedModel` nulls `cost` unconditionally so the projection
    // cannot fingerprint the backing model. Without this exclusion every
    // correctly-priced managed model would wear the badge.
    expect(isModelUnpriced(model({ aliased: true }))).toBe(false);
  });

  it("built-in with a null cost → NOT flagged, its remedy would 403", () => {
    // Built-in rates come from `SYSTEM_PROVIDER_KEYS`, and the badge's hint
    // points at `PUT /api/models/{id}`, which answers `systemEntityForbidden`
    // on a system id. A badge whose only remedy is refused is worse than none.
    expect(isModelUnpriced(model({ source: "built-in" }))).toBe(false);
  });

  it("asserted-free rates → not flagged (`0` is a price, absence is not)", () => {
    // The documented way to clear the badge on a genuinely free local model.
    expect(isModelUnpriced(model({ cost: { input: 0, output: 0 } }))).toBe(false);
  });

  it("each exclusion stands alone — neither one masks the other", () => {
    // Guards against a refactor that collapses the two into a single check.
    expect(isModelUnpriced(model({ source: "built-in", aliased: true }))).toBe(false);
    expect(isModelUnpriced(model({ source: "built-in", cost: { input: 3, output: 15 } }))).toBe(
      false,
    );
    expect(isModelUnpriced(model({ aliased: true, cost: { input: 3, output: 15 } }))).toBe(false);
  });
});

describe("unpriced badge wiring", () => {
  function read(relative: string): string {
    return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf-8");
  }

  it("the model column set decides through isModelUnpriced, not a restated condition", () => {
    // The badge moved with the column set when the page went onto `DataTable`;
    // the rule it must not restate moved with it.
    const source = read("../model-columns.tsx");
    expect(source).toContain("isModelUnpriced(m)");
    // A second copy of the rule in the JSX is exactly the drift this split
    // was made to prevent — the exclusions would only be pinned on one of them.
    expect(source).not.toContain("m.cost == null");
  });

  it("both locales define the badge keys the page renders", () => {
    // Flat dotted keys: a missing entry renders the raw key string silently.
    for (const locale of ["en", "fr"]) {
      const messages = JSON.parse(read(`../../../locales/${locale}/settings.json`)) as Record<
        string,
        string
      >;
      expect(messages["models.unpriced"]).toBeTruthy();
      expect(messages["models.unpricedHint"]).toBeTruthy();
    }
  });
});
