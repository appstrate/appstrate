// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { changedCatalogModelIds, shouldFailEmptyCanarySelection } from "../model-runtime-canary.ts";

const entry = (
  capabilities: string[],
  overrides: { contextWindow?: number; maxTokens?: number | null; inputCost?: number } = {},
) => ({
  contextWindow: overrides.contextWindow ?? 128_000,
  maxTokens: overrides.maxTokens ?? 8_192,
  capabilities,
  cost: { input: overrides.inputCost ?? 1, output: 2 },
});

describe("changedCatalogModelIds", () => {
  it("selects runtime-affecting capability and token-window changes", () => {
    const changed = changedCatalogModelIds(
      {
        flash: entry(["text"]),
        small: entry(["text"]),
      },
      {
        flash: entry(["text", "reasoning"]),
        small: entry(["text"], { maxTokens: 16_384 }),
      },
    );

    expect(changed).toEqual(new Set(["flash", "small"]));
  });

  it("ignores price-only drift because it cannot change the request protocol", () => {
    const changed = changedCatalogModelIds(
      { flash: entry(["text", "reasoning"], { inputCost: 1 }) },
      { flash: entry(["text", "reasoning"], { inputCost: 99 }) },
    );

    expect(changed).toEqual(new Set());
  });

  it("selects added and removed models", () => {
    expect(changedCatalogModelIds({ old: entry(["text"]) }, { next: entry(["text"]) })).toEqual(
      new Set(["old", "next"]),
    );
  });
});

describe("shouldFailEmptyCanarySelection", () => {
  it("allows a changed run to skip when drift is price-only", () => {
    expect(
      shouldFailEmptyCanarySelection({
        mode: "changed",
        requireTargets: true,
        configuredTargetCount: 2,
        explicitModelCount: 0,
      }),
    ).toBe(false);
  });

  it("still fails closed for an empty config or an explicit missing model", () => {
    expect(
      shouldFailEmptyCanarySelection({
        mode: "changed",
        requireTargets: true,
        configuredTargetCount: 0,
        explicitModelCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldFailEmptyCanarySelection({
        mode: "changed",
        requireTargets: true,
        configuredTargetCount: 2,
        explicitModelCount: 1,
      }),
    ).toBe(true);
  });
});
