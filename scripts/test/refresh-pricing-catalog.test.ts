// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 4 (model alias) — the featured-models generator must never surface a
 * model-alias backing. `aliasedBackings()` unions an explicit env list with the
 * aliased entries declared in SYSTEM_PROVIDER_KEYS; `buildFeatured()` filters
 * them out. Exclusion lives in the generator (not the JSON) so the weekly
 * auto-regen keeps dropping them.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { aliasedBackings, buildFeatured } from "../refresh-pricing-catalog.ts";

const ORIG_EXCLUDE = process.env.FEATURED_MODELS_EXCLUDE;
const ORIG_KEYS = process.env.SYSTEM_PROVIDER_KEYS;

afterEach(() => {
  // Restore — bun:test shares one process; leaking env poisons sibling files.
  if (ORIG_EXCLUDE === undefined) delete process.env.FEATURED_MODELS_EXCLUDE;
  else process.env.FEATURED_MODELS_EXCLUDE = ORIG_EXCLUDE;
  if (ORIG_KEYS === undefined) delete process.env.SYSTEM_PROVIDER_KEYS;
  else process.env.SYSTEM_PROVIDER_KEYS = ORIG_KEYS;
});

// Minimal stand-ins for the script's internal shapes (only the fields the
// functions read).
const snap = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, {} as never]));
const md = (entries: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(entries).map(([id, release_date]) => [
      id,
      { tool_call: true, release_date } as never,
    ]),
  );

describe("aliasedBackings", () => {
  it("reads the explicit FEATURED_MODELS_EXCLUDE list", () => {
    delete process.env.SYSTEM_PROVIDER_KEYS;
    process.env.FEATURED_MODELS_EXCLUDE = "deepseek-chat, gpt-4o-secret";
    const out = aliasedBackings();
    expect(out.has("deepseek-chat")).toBe(true);
    expect(out.has("gpt-4o-secret")).toBe(true);
  });

  it("derives backings from aliased SYSTEM_PROVIDER_KEYS entries (only aliased ones)", () => {
    delete process.env.FEATURED_MODELS_EXCLUDE;
    process.env.SYSTEM_PROVIDER_KEYS = JSON.stringify([
      {
        id: "k",
        providerId: "deepseek",
        apiKey: "x",
        models: [
          { id: "appstrate-medium", modelId: "deepseek-chat", aliased: true },
          { id: "plain", modelId: "deepseek-reasoner" },
        ],
      },
    ]);
    const out = aliasedBackings();
    expect(out.has("deepseek-chat")).toBe(true);
    expect(out.has("deepseek-reasoner")).toBe(false);
  });

  it("survives a malformed SYSTEM_PROVIDER_KEYS (explicit list still applies)", () => {
    process.env.SYSTEM_PROVIDER_KEYS = "{not json";
    process.env.FEATURED_MODELS_EXCLUDE = "deepseek-chat";
    const out = aliasedBackings();
    expect(out.has("deepseek-chat")).toBe(true);
  });
});

describe("buildFeatured", () => {
  it("excludes alias backings while keeping other models, capped at FEATURED_COUNT", () => {
    const snapshot = snap("a", "secret", "b", "c", "d");
    const models = md({
      a: "2026-01-04",
      secret: "2026-01-03",
      b: "2026-01-02",
      c: "2026-01-01",
      d: "2025-12-31",
    });
    const out = buildFeatured("deepseek", snapshot, models, new Set(["secret"]));
    expect(out).not.toContain("secret");
    // Newest-first, the backing dropped, capped at 3.
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("is a no-op filter when nothing is excluded", () => {
    const snapshot = snap("a", "b");
    const models = md({ a: "2026-01-02", b: "2026-01-01" });
    expect(buildFeatured("openai", snapshot, models, new Set())).toEqual(["a", "b"]);
  });
});
