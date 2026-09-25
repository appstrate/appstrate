// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildGenerationLabels } from "../src/components/model-generation-labels.ts";

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
