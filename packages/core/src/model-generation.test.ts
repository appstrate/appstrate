// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  applyModelGenerationCapabilitiesOverride,
  INHERITED_MODEL_GENERATION_CAPABILITIES,
  ModelGenerationError,
  reconcileModelGenerationSettings,
  resolveModelGenerationSettings,
  toNativeModelReasoningLevel,
  type ModelGenerationCapabilities,
} from "./model-generation.ts";

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

  it("rejects an unconfirmed reasoning level when every catalog fact is unknown", () => {
    expect(() =>
      resolveModelGenerationSettings({
        override: { temperature: 0.4, reasoningLevel: "medium" },
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
        override: { reasoningLevel: "high" },
      }),
    ).toThrow("does not support reasoning level 'high'");
  });

  it("rejects unconfirmed levels when LiteLLM only confirms one level", () => {
    expect(() =>
      resolveModelGenerationSettings({
        capabilities: capabilities({
          reasoning: {
            supported: "unknown",
            adaptive: null,
            levels: { minimal: "supported" },
          },
        }),
        override: { reasoningLevel: "high" },
      }),
    ).toThrow("does not support reasoning level 'high'");
  });
});

describe("applyModelGenerationCapabilitiesOverride", () => {
  it("overrides only provider-specific facts and preserves catalog reasoning", () => {
    const catalog = capabilities();
    expect(
      applyModelGenerationCapabilitiesOverride(catalog, { temperature: "unsupported" }),
    ).toEqual({ ...catalog, temperature: "unsupported" });
  });

  it("allows a provider override to clear adaptive reasoning", () => {
    const catalog = capabilities({
      reasoning: { ...capabilities().reasoning, adaptive: true },
    });
    expect(
      applyModelGenerationCapabilitiesOverride(catalog, { reasoning: { adaptive: null } }),
    ).toMatchObject({ reasoning: { adaptive: null } });
  });
});

describe("reconcileModelGenerationSettings", () => {
  it("removes settings explicitly rejected by the selected model", () => {
    expect(
      reconcileModelGenerationSettings(
        { temperature: 0.7, reasoningLevel: "xhigh" },
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
    const value = { temperature: 0.4, reasoningLevel: "high" } as const;
    expect(reconcileModelGenerationSettings(value, capabilities())).toBe(value);
  });

  it("removes unconfirmed levels from a known reasoning model", () => {
    expect(
      reconcileModelGenerationSettings(
        { reasoningLevel: "medium" },
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
        { reasoningLevel: "high" },
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

  it("clears every override for the public alias inherit-only contract", () => {
    expect(
      reconcileModelGenerationSettings(
        { temperature: 0.6, reasoningLevel: "high" },
        INHERITED_MODEL_GENERATION_CAPABILITIES,
      ),
    ).toEqual({});
  });
});

describe("toNativeModelReasoningLevel", () => {
  it("maps portable xhigh to the provider-native max value", () => {
    expect(
      toNativeModelReasoningLevel(
        "xhigh",
        capabilities({
          reasoning: {
            ...capabilities().reasoning,
            nativeLevels: { xhigh: "max" },
          },
        }),
      ),
    ).toBe("max");
  });
});
