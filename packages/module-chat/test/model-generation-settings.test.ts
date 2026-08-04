// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { ModelGenerationCapabilities } from "@appstrate/core/model-generation";
import { reconcileGenerationSettings } from "../src/ui/model-generation-settings.ts";

const SUPPORTED: ModelGenerationCapabilities = {
  temperature: "supported",
  temperatureWithReasoning: "supported",
  reasoning: {
    supported: "supported",
    adaptive: false,
    levels: {},
  },
};

describe("reconcileGenerationSettings", () => {
  test("removes a temperature rejected by the selected model", () => {
    expect(
      reconcileGenerationSettings(
        { temperature: 0.7, reasoningLevel: "medium" },
        { ...SUPPORTED, temperature: "unsupported" },
      ),
    ).toEqual({ reasoningLevel: "medium" });
  });

  test("removes reasoning when reasoning is unsupported", () => {
    expect(
      reconcileGenerationSettings(
        { temperature: 0.2, reasoningLevel: "high" },
        { ...SUPPORTED, reasoning: { ...SUPPORTED.reasoning, supported: "unsupported" } },
      ),
    ).toEqual({ temperature: 0.2 });
  });

  test("removes only a reasoning level explicitly rejected by the model", () => {
    expect(
      reconcileGenerationSettings(
        { temperature: 0.2, reasoningLevel: "xhigh" },
        {
          ...SUPPORTED,
          reasoning: {
            ...SUPPORTED.reasoning,
            levels: { xhigh: "unsupported" },
          },
        },
      ),
    ).toEqual({ temperature: 0.2 });
  });

  test("keeps reasoning and removes temperature when the combination is unsupported", () => {
    expect(
      reconcileGenerationSettings(
        { temperature: 0.8, reasoningLevel: "high" },
        { ...SUPPORTED, temperatureWithReasoning: "unsupported" },
      ),
    ).toEqual({ reasoningLevel: "high" });
  });

  test("keeps temperature when reasoning is explicitly off", () => {
    const value = { temperature: 0.8, reasoningLevel: "off" } as const;
    expect(
      reconcileGenerationSettings(value, {
        ...SUPPORTED,
        temperatureWithReasoning: "unsupported",
      }),
    ).toBe(value);
  });

  test("preserves the same object when capabilities accept the settings", () => {
    const value = { temperature: 0.5, reasoningLevel: "low" } as const;
    expect(reconcileGenerationSettings(value, SUPPORTED)).toBe(value);
  });
});
