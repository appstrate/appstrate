// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import codexModule from "../../src/index.ts";

const def = (codexModule.modelProviders?.() ?? [])[0]!;

describe("codex discovery candidates", () => {
  it("declares modelDiscoveryCandidates ⊇ featuredModels", () => {
    expect(def.modelDiscoveryCandidates).toBeDefined();
    for (const id of def.featuredModels) {
      expect(def.modelDiscoveryCandidates!).toContain(id);
    }
  });

  it("includes deprecated and preview ids beyond the featured floor", () => {
    // The probe — not the static list — decides what a given plan
    // serves, so candidates deliberately cover Pro-only previews and
    // recently-deprecated ids.
    expect(def.modelDiscoveryCandidates!.length).toBeGreaterThan(def.featuredModels.length);
    expect(def.modelDiscoveryCandidates!).toContain("gpt-5.3-codex-spark");
  });
});
