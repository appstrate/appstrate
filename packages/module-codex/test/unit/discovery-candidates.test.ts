// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import codexModule, { PRO_PLAN_MODEL_IDS } from "../../src/index.ts";

const def = (codexModule.modelProviders?.() ?? [])[0]!;

/** Pins the shape of the Codex model lists; rationale in `src/index.ts`. */
const featured = def.featuredModels as readonly string[];
const candidates = def.modelDiscoveryCandidates as readonly string[];

describe("codex discovery candidates", () => {
  it("declares both lists as explicit arrays (no catalog derivation)", () => {
    expect(Array.isArray(def.featuredModels)).toBe(true);
    expect(Array.isArray(def.modelDiscoveryCandidates)).toBe(true);
  });

  it("declares static modelDiscovery with candidates ⊇ featuredModels", () => {
    expect(def.modelDiscovery?.mode).toBe("static");
    expect(def.modelDiscoveryCandidates).toBeDefined();
    for (const id of featured) {
      expect(candidates).toContain(id);
    }
  });

  it("keeps every Pro-only id selectable but never featured", () => {
    // The deny-list plus these assertions are the whole enforcement of the
    // split — see the `PRO_PLAN_MODEL_IDS` docblock.
    expect(candidates.length).toBeGreaterThan(featured.length);
    for (const id of PRO_PLAN_MODEL_IDS) {
      expect(candidates).toContain(id);
      expect(featured).not.toContain(id);
    }
  });

  it("drops the ids deprecated for ChatGPT sign-in", () => {
    // Source: https://learn.chatgpt.com/docs/models (fetched 2026-07-27).
    // Keeping a deprecated id selectable only defers the failure to run time.
    for (const gone of ["gpt-5.2", "gpt-5.3-codex"]) {
      expect(featured).not.toContain(gone);
      expect(candidates).not.toContain(gone);
    }
  });
});
