// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  mapModelReasoningLevels,
  ModelGenerationError,
  reconcileModelGenerationSettings,
  resolveModelGenerationSettings,
  type ModelGenerationCapabilities,
} from "./model-generation.ts";

describe("mapModelReasoningLevels", () => {
  it("maps the complete canonical vocabulary", () => {
    expect(mapModelReasoningLevels((level) => level.toUpperCase())).toEqual({
      off: "OFF",
      minimal: "MINIMAL",
      low: "LOW",
      medium: "MEDIUM",
      high: "HIGH",
      xhigh: "XHIGH",
      max: "MAX",
    });
  });
});

const capabilities = (
  over: Partial<ModelGenerationCapabilities> = {},
): ModelGenerationCapabilities => ({
  temperature: "supported",
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
        defaults: { temperature: 0.7, reasoning_level: "medium" },
        override: { temperature: 0, reasoning_level: "high" },
      }),
    ).toEqual({ temperature: 0, reasoning_level: "high" });
  });

  it("treats null override fields as inherit", () => {
    expect(
      resolveModelGenerationSettings({
        capabilities: capabilities(),
        defaults: { temperature: 0.3, reasoning_level: "low" },
        override: { temperature: null, reasoning_level: null },
      }),
    ).toEqual({ temperature: 0.3, reasoning_level: "low" });
  });

  it("rejects an explicitly unsupported level", () => {
    expect(() =>
      resolveModelGenerationSettings({
        capabilities: capabilities(),
        override: { reasoning_level: "xhigh" },
      }),
    ).toThrow(ModelGenerationError);
  });

  it("rejects an unconfirmed reasoning level when every catalog fact is unknown", () => {
    expect(() =>
      resolveModelGenerationSettings({
        override: { temperature: 0.4, reasoning_level: "medium" },
      }),
    ).toThrow("does not support reasoning level 'medium'");
  });

  it("keeps an unknown custom provider forward-compatible for temperature alone", () => {
    expect(resolveModelGenerationSettings({ override: { temperature: 0.4 } })).toEqual({
      temperature: 0.4,
    });
  });

  it("rejects an unconfirmed level once reasoning support is known", () => {
    expect(() =>
      resolveModelGenerationSettings({
        capabilities: capabilities({
          reasoning: {
            supported: "supported",
            adaptive: false,
            levels: { high: "unknown" },
          },
        }),
        override: { reasoning_level: "high" },
      }),
    ).toThrow("does not support reasoning level 'high'");
  });

  it("rejects unconfirmed levels when the catalog confirms only one level", () => {
    expect(() =>
      resolveModelGenerationSettings({
        capabilities: capabilities({
          reasoning: {
            supported: "unknown",
            adaptive: null,
            levels: { minimal: "supported" },
          },
        }),
        override: { reasoning_level: "high" },
      }),
    ).toThrow("does not support reasoning level 'high'");
  });

  it("rejects a known-incompatible temperature and reasoning pair", () => {
    expect(() =>
      resolveModelGenerationSettings({
        capabilities: capabilities({
          reasoning: {
            ...capabilities().reasoning,
            temperature_compatible: "unsupported",
          },
        }),
        override: { temperature: 0.4, reasoning_level: "high" },
      }),
    ).toThrow("cannot combine a custom temperature with reasoning");
  });

  it("does not apply the pair constraint when reasoning is off", () => {
    expect(
      resolveModelGenerationSettings({
        capabilities: capabilities({
          reasoning: {
            ...capabilities().reasoning,
            temperature_compatible: "unsupported",
          },
        }),
        override: { temperature: 0.4, reasoning_level: "off" },
      }),
    ).toEqual({ temperature: 0.4, reasoning_level: "off" });
  });
});

describe("reconcileModelGenerationSettings", () => {
  it("removes settings explicitly rejected by the selected model", () => {
    expect(
      reconcileModelGenerationSettings(
        { temperature: 0.7, reasoning_level: "xhigh" },
        capabilities({
          temperature: "unsupported",
          reasoning: {
            ...capabilities().reasoning,
            levels: { xhigh: "unsupported" },
          },
        }),
      ),
    ).toEqual({});
  });

  it("preserves object identity when every setting remains compatible", () => {
    const value = { temperature: 0.4, reasoning_level: "high" } as const;
    expect(reconcileModelGenerationSettings(value, capabilities())).toBe(value);
  });

  it("drops temperature but keeps reasoning for a known-incompatible pair", () => {
    expect(
      reconcileModelGenerationSettings(
        { temperature: 0.4, reasoning_level: "high" },
        capabilities({
          reasoning: {
            ...capabilities().reasoning,
            temperature_compatible: "unsupported",
          },
        }),
      ),
    ).toEqual({ reasoning_level: "high" });
  });

  it("removes unconfirmed levels from a known reasoning model", () => {
    expect(
      reconcileModelGenerationSettings(
        { reasoning_level: "medium" },
        capabilities({
          reasoning: {
            supported: "supported",
            adaptive: false,
            levels: { medium: "unknown" },
          },
        }),
      ),
    ).toEqual({});
  });

  it("removes unconfirmed levels when only one explicit level is known", () => {
    expect(
      reconcileModelGenerationSettings(
        { reasoning_level: "high" },
        capabilities({
          reasoning: {
            supported: "unknown",
            adaptive: null,
            levels: { minimal: "supported" },
          },
        }),
      ),
    ).toEqual({});
  });
});
