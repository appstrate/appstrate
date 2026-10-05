// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  buildGenerationLabels,
  defaultReasoningLevel,
} from "../src/components/model-generation-labels.ts";
import type {
  ModelGenerationCapabilities,
  ModelReasoningLevel,
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
