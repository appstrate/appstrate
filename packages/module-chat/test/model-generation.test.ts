// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { applyGenerationToProxyBody } from "../src/llm.ts";

const parse = (body: BodyInit | null | undefined) => JSON.parse(String(body));

describe("applyGenerationToProxyBody", () => {
  it("uses adaptive Anthropic thinking when LiteLLM marks it supported", () => {
    const body = applyGenerationToProxyBody(
      JSON.stringify({ model: "preset" }),
      {
        apiShape: "anthropic-messages",
        generation: {
          temperature: "supported",
          reasoning: {
            supported: "supported",
            adaptive: true,
            levels: { xhigh: "supported" },
            nativeLevels: { xhigh: "max" },
          },
        },
      },
      { reasoningLevel: "xhigh" },
    );
    expect(parse(body)).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    });
  });

  it("translates portable minimal to Anthropic's native low effort", () => {
    const body = applyGenerationToProxyBody(
      JSON.stringify({ model: "preset" }),
      {
        apiShape: "anthropic-messages",
        generation: {
          temperature: "unsupported",
          reasoning: {
            supported: "supported",
            adaptive: true,
            levels: { minimal: "supported" },
            nativeLevels: { minimal: "low" },
          },
        },
      },
      { reasoningLevel: "minimal" },
    );
    expect(parse(body)).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
  });

  it("maps classic Anthropic levels to deterministic token budgets", () => {
    const body = applyGenerationToProxyBody(
      "{}",
      { apiShape: "anthropic-messages", generation: null },
      { reasoningLevel: "low" },
    );
    expect(parse(body).thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("maps OpenAI-compatible levels to reasoning_effort", () => {
    const body = applyGenerationToProxyBody(
      "{}",
      { apiShape: "openai-completions", generation: null },
      { reasoningLevel: "xhigh" },
    );
    expect(parse(body).reasoning_effort).toBe("xhigh");
  });

  it("keeps max distinct in OpenAI-compatible request bodies", () => {
    const body = applyGenerationToProxyBody(
      "{}",
      { apiShape: "openai-completions", generation: null },
      { reasoningLevel: "max" },
    );
    expect(parse(body).reasoning_effort).toBe("max");
  });

  it("removes Anthropic thinking fields for off", () => {
    const body = applyGenerationToProxyBody(
      JSON.stringify({ thinking: { type: "adaptive" }, output_config: { effort: "high" } }),
      { apiShape: "anthropic-messages", generation: null },
      { reasoningLevel: "off" },
    );
    expect(parse(body)).toEqual({});
  });
});
