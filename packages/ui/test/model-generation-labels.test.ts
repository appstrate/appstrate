// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildGenerationLabels } from "../src/components/model-generation-labels.ts";
import { defaultReasoningLevel } from "../src/components/default-reasoning-level.ts";
import type {
  ModelGenerationCapabilities,
  ModelReasoningLevel,
  ModelReasoningOff,
} from "@appstrate/core/model-generation";

/** A model taking exactly `levels`. */
const taking = (...levels: ModelReasoningLevel[]): ModelGenerationCapabilities => ({
  temperature: "supported",
  reasoning: {
    supported: "supported",
    adaptive: null,
    levels: Object.fromEntries(levels.map((level) => [level, "supported"])),
  },
});

/** A model taking off through high, with what the server reports `off` does on it. */
const withOff = (off: ModelReasoningOff | undefined): ModelGenerationCapabilities => {
  const capabilities = taking("off", "low", "medium", "high");
  return { ...capabilities, reasoning: { ...capabilities.reasoning, off } };
};

/** Echo the key, and the interpolated level, so the test sees what was asked for. */
const t = (key: string, options?: { level: string }) =>
  options ? `${key}(${options.level})` : key;

describe("buildGenerationLabels", () => {
  it("names the level an unset reasoning level resolves to", () => {
    const labels = buildGenerationLabels(t);
    expect(labels.reasoningInherit).toBe(
      "models.generation.reasoningInherit(models.generation.levels.medium)",
    );
    expect(labels.reasoningHint).toBe(
      "models.generation.reasoningHint(models.generation.levels.medium)",
    );
  });

  it("keeps the provider-default wording for temperature, which Pi omits when unset", () => {
    expect(buildGenerationLabels(t).inherit).toBe("models.generation.inherit");
  });

  it("names off for what it does where the server reports it unsent, and says so in the hint", () => {
    const labels = buildGenerationLabels(t, withOff("unsent"));
    expect(labels.levels.off).toBe("models.generation.levels.offSendsNothing");
    expect(labels.levels.low).toBe("models.generation.levels.low");
    expect(labels.reasoningHint).toBe(
      "models.generation.reasoningHint(models.generation.levels.medium) models.generation.reasoningOffSendsNothingHint",
    );
  });

  it("keeps the plain off label where off disables reasoning, or where nothing is reported", () => {
    for (const capabilities of [withOff("disables"), withOff(undefined), undefined]) {
      const labels = buildGenerationLabels(t, capabilities);
      expect(labels.levels.off).toBe("models.generation.levels.off");
      expect(labels.reasoningHint).toBe(
        "models.generation.reasoningHint(models.generation.levels.medium)",
      );
    }
  });
});

describe("defaultReasoningLevel", () => {
  it("is the platform default where the model takes it, or where nothing is known", () => {
    expect(defaultReasoningLevel(taking("off", "low", "medium", "high"))).toBe("medium");
    expect(defaultReasoningLevel(undefined)).toBe("medium");
  });

  it("is the nearest level the model takes — upward first, as the runner clamps", () => {
    expect(defaultReasoningLevel(taking("off", "low", "high", "max"))).toBe("high");
    expect(defaultReasoningLevel(taking("off", "minimal", "low"))).toBe("low");
  });

  it("is what the Auto label names", () => {
    expect(buildGenerationLabels(t, taking("off", "low", "high")).reasoningInherit).toBe(
      "models.generation.reasoningInherit(models.generation.levels.high)",
    );
  });
});
