// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import codexModule from "../../src/index.ts";

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

  it("includes the Pro-only preview beyond the featured floor", () => {
    // The run — not the static list — decides what a given plan serves, so
    // candidates cover `gpt-5.3-codex-spark`, which is recommended for
    // ChatGPT sign-in but absent from openai.json (hence unfeaturable).
    expect(candidates.length).toBeGreaterThan(featured.length);
    expect(candidates).toContain("gpt-5.3-codex-spark");
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
