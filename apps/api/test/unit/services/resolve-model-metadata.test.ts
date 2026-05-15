// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { resolveModelMetadata } from "../../../src/services/org-models.ts";

const FULL_CATALOG = {
  label: "GPT-4o",
  input: ["text", "image"] as ("text" | "image")[],
  contextWindow: 128000,
  maxTokens: 16384,
  reasoning: false,
  cost: { input: 2.5, output: 10 },
};

describe("resolveModelMetadata", () => {
  it("returns catalog defaults when src is empty", () => {
    expect(resolveModelMetadata({}, "gpt-4o", FULL_CATALOG)).toEqual({
      label: "GPT-4o",
      input: FULL_CATALOG.input,
      contextWindow: 128000,
      maxTokens: 16384,
      reasoning: false,
      cost: FULL_CATALOG.cost,
    });
  });

  it("src overrides win over catalog defaults", () => {
    const src = {
      label: "Custom Label",
      input: ["text"],
      contextWindow: 8000,
      maxTokens: 2048,
      reasoning: true,
      cost: { input: 1, output: 2 },
    };
    expect(resolveModelMetadata(src, "gpt-4o", FULL_CATALOG)).toEqual({
      label: "Custom Label",
      input: ["text"],
      contextWindow: 8000,
      maxTokens: 2048,
      reasoning: true,
      cost: { input: 1, output: 2 },
    });
  });

  it("falls back to modelId when neither src.label nor defaults.label is set", () => {
    expect(resolveModelMetadata({}, "anonymous-model", {}).label).toBe("anonymous-model");
  });

  it("returns null (not undefined) for absent capability fields", () => {
    const out = resolveModelMetadata({}, "x", {});
    expect(out.input).toBeNull();
    expect(out.contextWindow).toBeNull();
    expect(out.maxTokens).toBeNull();
    expect(out.reasoning).toBeNull();
    expect(out.cost).toBeNull();
  });

  it("treats explicit null in src as 'no override' and falls through to defaults", () => {
    // ?? operator: null falls through, only undefined falls through too.
    // This pins the documented behavior that DB-stored nulls = "use catalog".
    const src = {
      input: null,
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
      cost: null,
    };
    const out = resolveModelMetadata(src, "gpt-4o", FULL_CATALOG);
    expect(out.input).toEqual(FULL_CATALOG.input);
    expect(out.contextWindow).toBe(128000);
    expect(out.maxTokens).toBe(16384);
    expect(out.reasoning).toBe(false);
    expect(out.cost).toEqual(FULL_CATALOG.cost);
  });
});
