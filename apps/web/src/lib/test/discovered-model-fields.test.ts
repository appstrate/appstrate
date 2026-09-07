// SPDX-License-Identifier: Apache-2.0

/**
 * What picking a discovered model writes into the form.
 *
 * The omissions are the point: a listing that reports no context window must
 * leave that field alone rather than write a zero, because the form ships every
 * value it holds as an explicit override — an endpoint discovery ran against
 * has no catalog to resolve one from later.
 */

import { describe, it, expect } from "bun:test";
import { discoveredModelToFieldValues } from "../discovered-model-fields.ts";
import type { DiscoveredModel } from "../../hooks/use-model-provider-credentials.ts";

function discovered(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: "qwen3:8b",
    label: "Qwen 3 8B",
    context_window: 32768,
    max_tokens: 8192,
    input: ["text", "image"],
    reasoning: true,
    ...overrides,
  };
}

describe("discoveredModelToFieldValues", () => {
  it("maps a fully described model onto every field", () => {
    expect(discoveredModelToFieldValues(discovered())).toEqual({
      modelId: "qwen3:8b",
      label: "Qwen 3 8B",
      contextWindow: "32768",
      maxTokens: "8192",
      inputText: true,
      inputImage: true,
      reasoning: true,
    });
  });

  it("falls back to the id when the listing carries no label", () => {
    expect(discoveredModelToFieldValues(discovered({ label: null })).label).toBe("qwen3:8b");
  });

  it("omits every field the listing left null", () => {
    expect(
      discoveredModelToFieldValues(
        discovered({ context_window: null, max_tokens: null, input: null, reasoning: null }),
      ),
    ).toEqual({ modelId: "qwen3:8b", label: "Qwen 3 8B" });
  });

  it("reads the modalities out of the input list", () => {
    expect(discoveredModelToFieldValues(discovered({ input: ["text"] }))).toMatchObject({
      inputText: true,
      inputImage: false,
    });
    expect(discoveredModelToFieldValues(discovered({ input: [] }))).toMatchObject({
      inputText: false,
      inputImage: false,
    });
  });

  it("keeps a reported false rather than dropping it", () => {
    expect(discoveredModelToFieldValues(discovered({ reasoning: false }))).toMatchObject({
      reasoning: false,
    });
  });
});
