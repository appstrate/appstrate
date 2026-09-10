// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import codexModule, { PRO_PLAN_MODEL_IDS } from "../../src/index.ts";

const def = (codexModule.modelProviders?.() ?? [])[0]!;

/**
 * Codex declares EXPLICIT arrays, not a catalog selector: the ChatGPT
 * sign-in set is defined by OpenAI documentation and is deliberately narrower
 * than openai.json (which carries API-only models). Both lists are therefore
 * assertable literally here — no catalog is needed.
 */
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
    // `featuredModels` is not just a picker section: the platform auto-seeds
    // every featured id into `org_models` on first connection and promotes the
    // first inserted row to the org default. So a Pro-only id in that list is
    // handed to a Plus subscriber by the platform itself, and the plan refuses
    // it at the first run. Candidates are the opposite: selecting one is a
    // deliberate act by someone who knows their plan.
    //
    // No feed carries plan tiers (see `PRO_PLAN_MODEL_IDS`), so this is the
    // whole enforcement — the deny-list plus these two assertions.
    expect(candidates.length).toBeGreaterThan(featured.length);
    for (const id of PRO_PLAN_MODEL_IDS) {
      expect(candidates).toContain(id);
      expect(featured).not.toContain(id);
    }
  });

  it("names both documented Pro-only ids", () => {
    // Pins the deny-list's contents, so removing an id from it is a visible
    // edit rather than a silent one that quietly re-opens the test above.
    // Source: https://learn.chatgpt.com/docs/models (Codex with ChatGPT
    // sign-in) — `gpt-5.3-codex-spark` read 2026-07-27, `gpt-6-astra`
    // 2026-09-07.
    expect([...PRO_PLAN_MODEL_IDS]).toEqual(["gpt-6-astra", "gpt-5.3-codex-spark"]);
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
