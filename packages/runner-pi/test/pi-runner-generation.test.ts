// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  prepareRequestedThinkingLevel,
  preserveRequestedThinkingLevel,
  type PiModelConfig,
} from "../src/pi-runner.ts";

const model = (over: Partial<PiModelConfig> = {}): PiModelConfig =>
  ({
    id: "reasoner",
    name: "Reasoner",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...over,
  }) as PiModelConfig;

describe("preserveRequestedThinkingLevel", () => {
  it("adds an xhigh pass-through so Pi does not silently clamp an allowed attempt", () => {
    expect(preserveRequestedThinkingLevel(model(), "xhigh").thinkingLevelMap?.xhigh).toBe("xhigh");
  });

  it("preserves an explicit provider mapping or refusal", () => {
    const mapped = model({ thinkingLevelMap: { xhigh: "max" } });
    const refused = model({ thinkingLevelMap: { xhigh: null } });
    expect(preserveRequestedThinkingLevel(mapped, "xhigh")).toBe(mapped);
    expect(preserveRequestedThinkingLevel(refused, "xhigh")).toBe(refused);
  });

  it("does not mutate other reasoning levels", () => {
    const original = model();
    expect(preserveRequestedThinkingLevel(original, "high")).toBe(original);
  });
});

describe("prepareRequestedThinkingLevel", () => {
  it("routes portable max through Pi's xhigh slot without collapsing its native value", () => {
    const prepared = prepareRequestedThinkingLevel(model(), "max");
    expect(prepared.thinkingLevel).toBe("xhigh");
    expect(prepared.model.thinkingLevelMap?.xhigh).toBe("max");
  });

  it("keeps xhigh distinct when the same model also supports max", () => {
    const prepared = prepareRequestedThinkingLevel(
      model({ thinkingLevelMap: { xhigh: "xhigh", max: "max" } } as Partial<PiModelConfig>),
      "xhigh",
    );
    expect(prepared.thinkingLevel).toBe("xhigh");
    expect(prepared.model.thinkingLevelMap?.xhigh).toBe("xhigh");
  });
});
