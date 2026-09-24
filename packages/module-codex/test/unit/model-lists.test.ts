// SPDX-License-Identifier: Apache-2.0

/**
 * Codex features a pinned array; its offer is Pi's `openai-codex` records,
 * which the API suite checks the array against (this package has no registry).
 */

import { describe, it, expect } from "bun:test";
import codexModule, { PRO_PLAN_MODEL_IDS } from "../../src/index.ts";

const def = (codexModule.modelProviders?.() ?? [])[0]!;

describe("codex model lists", () => {
  it("features the recommended set as a pinned array", () => {
    expect(def.featuredModels).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  it("never features a Pro-plan model (auto-seeded models must work on every plan)", () => {
    expect(def.featuredModels.filter((id) => PRO_PLAN_MODEL_IDS.includes(id as never))).toEqual([]);
  });

  it("offers Pi's openai-codex records, discovered statically", () => {
    expect(def.catalogProviderId).toBe("openai-codex");
    expect(def.modelDiscovery).toEqual({ mode: "static" });
  });
});
