// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { pickModel, type OrgModel } from "../src/llm.ts";

function model(overrides: Partial<OrgModel>): OrgModel {
  return {
    id: overrides.id ?? "m",
    modelId: overrides.modelId ?? overrides.id ?? "m",
    apiShape: overrides.apiShape ?? "openai-completions",
    providerId: overrides.providerId,
    enabled: overrides.enabled,
    is_default: overrides.is_default,
    source: overrides.source,
  };
}

describe("pickModel", () => {
  test("keeps explicit model selection even for a deprioritized provider", () => {
    const deepseek = model({
      id: "deepseek",
      providerId: "deepseek",
      source: "built-in",
      is_default: true,
    });
    const openai = model({ id: "openai", providerId: "openai", source: "built-in" });

    expect(pickModel([deepseek, openai], "deepseek")).toBe(deepseek);
  });

  test("deprioritizes the built-in DeepSeek fallback for chat tool orchestration", () => {
    const deepseek = model({
      id: "deepseek",
      providerId: "deepseek",
      source: "built-in",
      is_default: true,
    });
    const openai = model({ id: "openai", providerId: "openai", source: "built-in" });

    expect(pickModel([deepseek, openai])).toBe(openai);
  });

  test("respects a custom default model", () => {
    const custom = model({
      id: "custom",
      providerId: "deepseek",
      source: "custom",
      is_default: true,
    });
    const openai = model({ id: "openai", providerId: "openai", source: "built-in" });

    expect(pickModel([custom, openai])).toBe(custom);
  });
});
