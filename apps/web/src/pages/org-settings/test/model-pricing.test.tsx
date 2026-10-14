// SPDX-License-Identifier: Apache-2.0

/**
 * The "No pricing" badge exists so a self-hoster learns a model is unpriced
 * BEFORE spending on it. This exercises the pure rule the badge renders
 * (`model-pricing.ts`) — each exclusion on its own, because an exclusion
 * silently dropped is a false positive on every alias or every built-in row —
 * then the model cell that draws it, row by row.
 */

import { describe, it, expect } from "bun:test";
import { ModelsCell } from "../../../components/provider-models-cell.tsx";
import i18n, { i18nReady } from "../../../i18n.ts";
import { orgModelFixture as orgModel } from "../../../test/org-model-fixture.ts";
import { render } from "../../../test/render.tsx";
import { isModelUnpriced, type ModelPricingFields } from "../model-pricing.ts";

await i18nReady;

/** A custom, non-aliased, unpriced row — the one shape that SHOULD flag. */
function model(overrides: Partial<ModelPricingFields> = {}): ModelPricingFields {
  return { source: "custom", aliased: false, cost: null, ...overrides };
}

describe("isModelUnpriced", () => {
  it("a custom model with no rates → flagged", () => {
    // The self-hoster case: an openai-compatible/custom model misses the
    // model catalog, so `cost` resolves to null and every run records $0.
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
    // points at `PATCH /api/models/{id}`, which answers `systemEntityForbidden`
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

describe("the unpriced badge", () => {
  const cell = () =>
    render(
      <ModelsCell
        models={[
          orgModel({ id: "mdl_priced", label: "Priced" }),
          orgModel({ id: "mdl_local", label: "Local", cost: null }),
          orgModel({ id: "mdl_alias", label: "Alias", cost: null, aliased: true }),
        ]}
      />,
    );
  /** The markup of one model's name, up to the next one. */
  const nameOf = (html: string, label: string, next?: string) =>
    html.slice(html.indexOf(`>${label}<`), next ? html.indexOf(`>${next}<`) : undefined);

  it("marks the unpriced model alone, in both languages", async () => {
    for (const language of ["fr", "en"]) {
      await i18n.changeLanguage(language);
      const label = i18n.t("models.unpriced", { ns: "settings" });
      const html = cell();
      expect(nameOf(html, "Local", "Alias")).toContain(`aria-label="${label}"`);
      expect(nameOf(html, "Priced", "Local")).not.toContain(`aria-label="${label}"`);
      expect(nameOf(html, "Alias")).not.toContain(`aria-label="${label}"`);
      expect(html.split(`aria-label="${label}"`)).toHaveLength(2);
      expect(html).toContain(`title="${i18n.t("models.unpricedHint", { ns: "settings" })}"`);
    }
    await i18n.changeLanguage("fr");
  });
});
