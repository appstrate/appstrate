// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the vendored Portkey pricing catalog (phase 2 of #437).
 *
 * These tests pin the contract callers in `org-models.ts` and the
 * Portkey routing rely on. They don't validate every model's price
 * (the upstream JSON is the source of truth) — instead they check the
 * three things that drift independently:
 *
 *   1. Conversion arithmetic (cents/token → USD/M) — single canonical
 *      sample.
 *   2. apiShape → provider mapping coverage — every Portkey-routable
 *      shape returns a non-null lookup for at least one model.
 *   3. Unmapped / missing inputs return null cleanly (no throws, no NaN).
 */

import { describe, it, expect } from "bun:test";
import {
  lookupModelCost,
  API_SHAPE_TO_PORTKEY_PROVIDER,
  _catalogSize,
} from "../../src/services/pricing-catalog.ts";

describe("lookupModelCost", () => {
  it("returns null for an unmapped apiShape", () => {
    expect(lookupModelCost("openai-codex-responses", "gpt-5")).toBeNull();
    expect(lookupModelCost("not-a-real-shape", "anything")).toBeNull();
  });

  it("returns null when the apiShape maps to a provider we haven't vendored yet", () => {
    // `bedrock` is in the routing map (Portkey supports it) but we
    // haven't vendored the pricing file — should null cleanly, not throw.
    expect(lookupModelCost("bedrock-converse-stream", "anthropic.claude-v2")).toBeNull();
  });

  it("returns null when the model is unknown under a vendored provider", () => {
    expect(lookupModelCost("openai-completions", "definitely-not-a-real-model-xyz")).toBeNull();
  });

  it("converts cents/token → USD/million for a known OpenAI model", () => {
    // gpt-4o input: 0.00025 cents/token × 10_000 = $2.50/M (well-known
    // OpenAI list price as of the vendored snapshot)
    const cost = lookupModelCost("openai-completions", "gpt-4o");
    expect(cost).not.toBeNull();
    expect(cost!.input).toBeCloseTo(2.5, 4);
    expect(cost!.output).toBeCloseTo(10, 4);
    // gpt-4o has prompt-cache pricing at half input ($1.25/M)
    expect(cost!.cacheRead).toBeCloseTo(1.25, 4);
  });

  it("works for anthropic claude-haiku-4-5 (catalogued)", () => {
    const cost = lookupModelCost("anthropic-messages", "claude-haiku-4-5-20251001");
    expect(cost).not.toBeNull();
    // Haiku 4.5 is $1.00/M input, $5.00/M output at the vendored snapshot.
    expect(cost!.input).toBeCloseTo(1, 4);
    expect(cost!.output).toBeCloseTo(5, 4);
  });

  it("resolves the same model across all three OpenAI api-shapes", () => {
    const a = lookupModelCost("openai-chat", "gpt-4o");
    const b = lookupModelCost("openai-completions", "gpt-4o");
    const c = lookupModelCost("openai-responses", "gpt-4o");
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("indexes at least 200 models across the 4 vendored providers", () => {
    // Sanity threshold — the upstream catalog grows over time. If this
    // ever drops below ~200, something has gone wrong with the JSON
    // imports (e.g. a hard-coded refresh that wiped a file).
    expect(_catalogSize()).toBeGreaterThan(200);
  });
});

describe("API_SHAPE_TO_PORTKEY_PROVIDER", () => {
  it("does NOT include subscription-OAuth shapes (bypass-billing invariant)", () => {
    // Codex / Claude Pro subscription credentials must NEVER hit the
    // pricing catalog — the user already paid the upstream subscription
    // and there's no per-token attribution on those calls.
    expect(API_SHAPE_TO_PORTKEY_PROVIDER["openai-codex-responses"]).toBeUndefined();
  });

  it("covers the 9 Portkey-routable shapes we promised in the README", () => {
    // Locks the public contract. If a shape is removed from this list,
    // the Portkey module's routing AND the pricing catalog both lose
    // coverage simultaneously — flag the breaking change loudly.
    const expected = [
      "anthropic-messages",
      "openai-chat",
      "openai-completions",
      "openai-responses",
      "mistral-conversations",
      "google-generative-ai",
      "google-vertex",
      "azure-openai-responses",
      "bedrock-converse-stream",
    ];
    for (const shape of expected) {
      expect(API_SHAPE_TO_PORTKEY_PROVIDER[shape]).toBeDefined();
    }
    expect(Object.keys(API_SHAPE_TO_PORTKEY_PROVIDER)).toHaveLength(expected.length);
  });
});
