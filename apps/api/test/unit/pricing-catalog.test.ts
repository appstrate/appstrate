// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the vendored LiteLLM model catalog (#437 phases 2 + 6).
 *
 * The catalog is keyed on `providerId` — one JSON file per provider.
 * These tests pin the contract callers rely on:
 *
 *   1. `lookupCatalogModel(providerId, modelId)` — full metadata block
 *      (callers needing only `cost` read `?.cost ?? null`).
 *   2. `listCatalogModels(providerId)` — every catalogued model for a
 *      provider (drives the picker's "All models" group).
 */

import { describe, it, expect } from "bun:test";
import {
  _catalogSize,
  listCatalogModels,
  lookupCatalogModel,
} from "../../src/services/pricing-catalog.ts";

describe("lookupCatalogModel", () => {
  it("returns null for an unknown providerId", () => {
    expect(lookupCatalogModel("not-a-real-provider", "anything")).toBeNull();
  });

  it("returns null when the model is unknown under a vendored provider", () => {
    expect(lookupCatalogModel("openai", "definitely-not-a-real-model-xyz")).toBeNull();
  });

  it("returns null for subscription-OAuth providers (codex bypass)", () => {
    // Codex / Claude Pro are flat-fee subscriptions — no per-token cost
    // attribution. The catalog must not vendor them.
    expect(lookupCatalogModel("codex", "gpt-5.5")).toBeNull();
  });

  it("returns canonical pricing for anthropic claude-haiku-4-5", () => {
    const entry = lookupCatalogModel("anthropic", "claude-haiku-4-5-20251001");
    expect(entry).not.toBeNull();
    expect(entry!.cost.input).toBeCloseTo(1, 4);
    expect(entry!.cost.output).toBeCloseTo(5, 4);
    expect(entry!.cost.cacheRead).toBeCloseTo(0.1, 4);
    expect(entry!.cost.cacheWrite).toBeCloseTo(1.25, 4);
  });

  it("returns the full metadata block (not just cost)", () => {
    const entry = lookupCatalogModel("anthropic", "claude-haiku-4-5-20251001");
    expect(entry).not.toBeNull();
    expect(entry!.contextWindow).toBe(200_000);
    expect(entry!.maxTokens).toBe(64_000);
    expect(entry!.capabilities).toEqual(expect.arrayContaining(["text", "image", "reasoning"]));
    expect(entry!.label).toBeString();
  });
});

describe("listCatalogModels", () => {
  it("returns every catalogued model for a provider", () => {
    const all = listCatalogModels("anthropic");
    expect(all.length).toBeGreaterThan(15);
    // Each entry shape matches CatalogModel + id.
    for (const m of all) {
      expect(m.id).toBeString();
      expect(m.contextWindow).toBeNumber();
      expect(m.cost.input).toBeNumber();
    }
  });

  it("covers the 7 providers we vendor", () => {
    // Pin the providerId surface — adding/removing a vendored JSON
    // without updating PROVIDER_INDEX silently drops coverage.
    for (const providerId of [
      "openai",
      "anthropic",
      "mistral",
      "google-ai",
      "cerebras",
      "groq",
      "xai",
    ]) {
      const models = listCatalogModels(providerId);
      expect(models.length).toBeGreaterThan(0);
    }
  });

  it("returns empty for non-catalogued providers (openrouter, openai-compatible, codex)", () => {
    expect(listCatalogModels("openrouter")).toEqual([]);
    expect(listCatalogModels("openai-compatible")).toEqual([]);
    expect(listCatalogModels("codex")).toEqual([]);
  });
});

describe("_catalogSize", () => {
  it("indexes at least 200 chat models across the 7 vendored providers", () => {
    expect(_catalogSize()).toBeGreaterThan(200);
  });
});
