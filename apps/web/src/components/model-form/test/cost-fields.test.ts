// SPDX-License-Identifier: Apache-2.0

/**
 * The model form's pricing section exists so an org can price a model the
 * vendored catalog does not cover (`resolveCatalogDefaults` returns `{}` for an
 * unmapped provider, an unknown model id, or an entry LiteLLM dropped for
 * lacking pricing) — without it those runs are recorded at a confident $0.
 *
 * The invariant these tests pin: an EMPTY rate is never coerced to `0`. The web
 * test runner has no DOM, so this exercises the pure fold/projection the inputs
 * are wired to, plus a source scan that the modal really uses them.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COST_FIELD_NAMES,
  costFromFields,
  costToFields,
  normalizeCost,
  parseRate,
  type CostFields,
} from "../cost-fields.ts";

const fields = (over: Partial<CostFields> = {}): CostFields => ({
  input: "",
  output: "",
  cacheRead: "",
  cacheWrite: "",
  ...over,
});

describe("parseRate", () => {
  it("accepts an empty field as 'no rate', with no value", () => {
    expect(parseRate("")).toEqual({ ok: true });
    expect(parseRate("   ")).toEqual({ ok: true });
  });

  it("keeps an explicit 0 as a real rate — 'free' is not 'unknown'", () => {
    expect(parseRate("0")).toEqual({ ok: true, value: 0 });
  });

  it("accepts decimals and surrounding whitespace", () => {
    expect(parseRate(" 0.075 ")).toEqual({ ok: true, value: 0.075 });
  });

  it("rejects negatives and non-numbers", () => {
    expect(parseRate("-1").ok).toBe(false);
    expect(parseRate("abc").ok).toBe(false);
    expect(parseRate("Infinity").ok).toBe(false);
    expect(parseRate("NaN").ok).toBe(false);
  });
});

describe("costFromFields", () => {
  it("omits an empty cache rate instead of sending 0", () => {
    const cost = costFromFields(fields({ input: "3", output: "15" }));
    expect(cost).toEqual({ input: 3, output: 15 });
    expect(cost).not.toHaveProperty("cacheRead");
    expect(cost).not.toHaveProperty("cacheWrite");
  });

  it("keeps an explicit zero cache rate", () => {
    expect(costFromFields(fields({ input: "3", output: "15", cacheRead: "0" }))).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0,
    });
  });

  it("carries both cache rates when both are typed", () => {
    expect(
      costFromFields(fields({ input: "3", output: "15", cacheRead: "0.3", cacheWrite: "3.75" })),
    ).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  it("is null when the model is left entirely unpriced", () => {
    expect(costFromFields(fields())).toBeNull();
  });

  it("is null on a half-filled base rate rather than padding the other with 0", () => {
    expect(costFromFields(fields({ input: "3" }))).toBeNull();
    expect(costFromFields(fields({ output: "15" }))).toBeNull();
    expect(costFromFields(fields({ cacheRead: "0.3" }))).toBeNull();
  });

  it("is null when a base rate is unparseable", () => {
    expect(costFromFields(fields({ input: "-3", output: "15" }))).toBeNull();
  });
});

describe("normalizeCost", () => {
  it("drops absent cache rates rather than zeroing them", () => {
    // Exactly the mistral / cerebras / together-ai shape: 0 of their catalog
    // entries carry a `cacheRead`.
    expect(normalizeCost({ input: 2, output: 6 })).toEqual({ input: 2, output: 6 });
  });

  it("keeps a zero rate the catalog states explicitly", () => {
    expect(normalizeCost({ input: 2, output: 6, cacheRead: 0 })).toEqual({
      input: 2,
      output: 6,
      cacheRead: 0,
    });
  });

  it("treats a cost with no base rates as no pricing at all", () => {
    expect(normalizeCost({})).toBeNull();
    expect(normalizeCost({ cacheRead: 0.3 })).toBeNull();
    expect(normalizeCost(null)).toBeNull();
    expect(normalizeCost(undefined)).toBeNull();
  });
});

describe("costToFields", () => {
  it("renders a missing rate as an empty field, not '0'", () => {
    expect(costToFields({ input: 3, output: 15 })).toEqual({
      input: "3",
      output: "15",
      cacheRead: "",
      cacheWrite: "",
    });
  });

  it("renders an explicit zero as '0'", () => {
    expect(costToFields({ input: 3, output: 15, cacheRead: 0 }).cacheRead).toBe("0");
  });

  it("renders no pricing as four empty fields", () => {
    expect(costToFields(null)).toEqual(fields());
  });

  it("round-trips through costFromFields", () => {
    const cost = { input: 3, output: 15, cacheWrite: 3.75 };
    expect(costFromFields(costToFields(cost))).toEqual(cost);
  });
});

describe("model-form-modal wiring", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../model-form-modal.tsx", import.meta.url)),
    "utf8",
  );

  it("renders an input for each of the four rates", () => {
    for (const bucket of Object.keys(COST_FIELD_NAMES)) {
      expect(src).toContain(`renderRateField("${bucket}"`);
    }
  });

  it("raises costEdited on a rate edit — that flag is what persists the override", () => {
    expect(src).toContain("setCost(costFromFields(costFieldsWith(bucket, e.target.value)));");
    expect(src).toContain("setCostEdited(true);");
    // …and the submit path still gates the payload on it.
    expect(src).toContain("...(costEdited && cost ? { cost } : {}),");
  });

  it("displays a catalog preset without flagging it as edited", () => {
    expect(src).toContain("showCost(normalizeCost(preset.cost));\n    setCostEdited(false);");
    // The old `preset.cost.cacheRead ?? 0` fabricated a free cache bucket.
    expect(src).not.toContain("preset.cost.cacheRead ?? 0");
  });

  it("tells the user an unpriced model records $0", () => {
    expect(src).toContain("cost === null && (");
    expect(src).toContain('t("models.form.pricingMissing")');
  });
});
