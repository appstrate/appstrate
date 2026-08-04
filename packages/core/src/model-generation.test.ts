// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  ModelGenerationError,
  resolveModelGenerationSettings,
  type ModelGenerationCapabilities,
} from "./model-generation.ts";

const capabilities = (
  over: Partial<ModelGenerationCapabilities> = {},
): ModelGenerationCapabilities => ({
  temperature: "supported",
  temperatureWithReasoning: "supported",
  reasoning: {
    supported: "supported",
    adaptive: false,
    levels: {
      off: "supported",
      minimal: "supported",
      low: "supported",
      medium: "supported",
      high: "supported",
      xhigh: "unsupported",
    },
  },
  ...over,
});

describe("resolveModelGenerationSettings", () => {
  it("preserves the historical empty configuration", () => {
    expect(resolveModelGenerationSettings({})).toEqual({});
  });

  it("keeps temperature zero and applies invocation precedence", () => {
    expect(
      resolveModelGenerationSettings({
        capabilities: capabilities(),
        defaults: { temperature: 0.7, reasoningLevel: "medium" },
        override: { temperature: 0, reasoningLevel: "high" },
      }),
    ).toEqual({ temperature: 0, reasoningLevel: "high" });
  });

  it("treats null override fields as inherit", () => {
    expect(
      resolveModelGenerationSettings({
        capabilities: capabilities(),
        defaults: { temperature: 0.3, reasoningLevel: "low" },
        override: { temperature: null, reasoningLevel: null },
      }),
    ).toEqual({ temperature: 0.3, reasoningLevel: "low" });
  });

  it("rejects an explicitly unsupported level", () => {
    expect(() =>
      resolveModelGenerationSettings({
        capabilities: capabilities(),
        override: { reasoningLevel: "xhigh" },
      }),
    ).toThrow(ModelGenerationError);
  });

  it("rejects temperature with reasoning when the pair is unsupported", () => {
    expect(() =>
      resolveModelGenerationSettings({
        capabilities: capabilities({ temperatureWithReasoning: "unsupported" }),
        override: { temperature: 0.2, reasoningLevel: "high" },
      }),
    ).toThrow("cannot combine");
  });

  it("allows unknown catalog facts for custom providers", () => {
    expect(
      resolveModelGenerationSettings({
        override: { temperature: 0.4, reasoningLevel: "medium" },
      }),
    ).toEqual({ temperature: 0.4, reasoningLevel: "medium" });
  });
});
