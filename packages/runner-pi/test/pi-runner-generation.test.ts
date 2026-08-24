// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  prepareRequestedThinkingLevel,
  preserveRequestedThinkingLevel,
  type PiModelConfig,
} from "../src/pi-runner.ts";
import { streamSimple } from "@earendil-works/pi-ai/compat";

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
  // Pi admits `off`…`high` for any reasoning model but demands an explicit
  // mapping for these two, and clamps DOWN without one.
  for (const level of ["xhigh", "max"] as const) {
    it(`adds a ${level} pass-through so Pi does not silently clamp an allowed attempt`, () => {
      expect(preserveRequestedThinkingLevel(model(), level).thinkingLevelMap?.[level]).toBe(level);
    });
  }

  it("preserves an explicit provider mapping or refusal", () => {
    const mapped = model({ thinkingLevelMap: { xhigh: "max" } });
    const refused = model({ thinkingLevelMap: { xhigh: null } });
    expect(preserveRequestedThinkingLevel(mapped, "xhigh")).toBe(mapped);
    expect(preserveRequestedThinkingLevel(refused, "xhigh")).toBe(refused);
  });

  // A refusal is a fact the platform's own catalog published. Pre-0.84 the
  // `max` path read it as `levelMap?.max ?? "max"` and forced a pass-through
  // anyway — overriding it. It is honoured now.
  it("honours an explicit max refusal instead of forcing it through", () => {
    const refused = model({ thinkingLevelMap: { max: null } });
    expect(preserveRequestedThinkingLevel(refused, "max")).toBe(refused);
  });

  it("leaves a non-reasoning model alone", () => {
    const plain = model({ reasoning: false });
    expect(preserveRequestedThinkingLevel(plain, "max")).toBe(plain);
  });

  it("does not mutate other reasoning levels", () => {
    const original = model();
    expect(preserveRequestedThinkingLevel(original, "high")).toBe(original);
    expect(preserveRequestedThinkingLevel(original, "off")).toBe(original);
  });
});

describe("prepareRequestedThinkingLevel", () => {
  it("adapts the stable Appstrate Codex base URL to Pi 0.84 exactly once", () => {
    const prepared = prepareRequestedThinkingLevel(
      model({ api: "openai-codex-responses", baseUrl: "https://proxy.test/llm/" }),
      "off",
    );
    const alreadyPrepared = prepareRequestedThinkingLevel(
      model({ api: "openai-codex-responses", baseUrl: "https://proxy.test/llm/codex" }),
      "off",
    );

    expect(prepared.model.baseUrl).toBe("https://proxy.test/llm/codex");
    expect(alreadyPrepared.model.baseUrl).toBe("https://proxy.test/llm/codex");
  });

  // Pi 0.84 has a first-class `max` selector (`pi-agent-core` `ThinkingLevel`),
  // so the portable vocabulary passes through 1:1 — no more xhigh disguise.
  it("passes portable max through as Pi's own max level", () => {
    const prepared = prepareRequestedThinkingLevel(model(), "max");
    expect(prepared.thinkingLevel).toBe("max");
    expect(prepared.model.thinkingLevelMap?.max).toBe("max");
  });

  // The regression the disguise caused: routing max through the xhigh slot
  // rewrote a mapping the model owns, and the adaptive-Anthropic path reads it
  // back per level (`mapThinkingLevelToEffort`).
  it("leaves the model's own xhigh mapping untouched when max is requested", () => {
    const prepared = prepareRequestedThinkingLevel(
      model({ thinkingLevelMap: { xhigh: "high", max: "max" } } as Partial<PiModelConfig>),
      "max",
    );
    expect(prepared.thinkingLevel).toBe("max");
    expect(prepared.model.thinkingLevelMap?.xhigh).toBe("high");
    expect(prepared.model.thinkingLevelMap?.max).toBe("max");
  });

  it("keeps xhigh distinct when the same model also supports max", () => {
    const prepared = prepareRequestedThinkingLevel(
      model({ thinkingLevelMap: { xhigh: "xhigh", max: "max" } } as Partial<PiModelConfig>),
      "xhigh",
    );
    expect(prepared.thinkingLevel).toBe("xhigh");
    expect(prepared.model.thinkingLevelMap?.xhigh).toBe("xhigh");
  });

  // Wire-level proof that the portable `max` survives the whole path on an
  // adaptive-thinking Anthropic model, where Pi resolves the effort from the
  // per-level mapping rather than from a token budget.
  it("emits the max effort on an adaptive Anthropic payload", async () => {
    const adaptive = model({
      api: "anthropic-messages",
      provider: "anthropic",
      maxTokens: 65_536,
      compat: { forceAdaptiveThinking: true },
    } as Partial<PiModelConfig>);
    const prepared = prepareRequestedThinkingLevel(adaptive, "max");
    let payload: unknown;
    const result = await streamSimple(
      prepared.model,
      { messages: [] },
      {
        apiKey: "test-key",
        reasoning: prepared.thinkingLevel === "off" ? undefined : prepared.thinkingLevel,
        thinkingBudgets: prepared.thinkingBudgets,
        onPayload: (nextPayload) => {
          payload = nextPayload;
          throw new Error("payload captured");
        },
      },
    ).result();

    expect(result.errorMessage).toBe("payload captured");
    expect(payload).toMatchObject({ output_config: { effort: "max" } });
  });

  it("emits a distinct classic Anthropic payload for max", async () => {
    const prepared = prepareRequestedThinkingLevel(
      model({ api: "anthropic-messages", provider: "anthropic", maxTokens: 65_536 }),
      "max",
    );
    let payload: unknown;
    const result = await streamSimple(
      prepared.model,
      { messages: [] },
      {
        apiKey: "test-key",
        reasoning: prepared.thinkingLevel === "off" ? undefined : prepared.thinkingLevel,
        thinkingBudgets: prepared.thinkingBudgets,
        onPayload: (nextPayload) => {
          payload = nextPayload;
          throw new Error("payload captured");
        },
      },
    ).result();

    expect(result.errorMessage).toBe("payload captured");
    expect(payload).toMatchObject({
      max_tokens: 65_536,
      thinking: { type: "enabled", budget_tokens: 32_768, display: "summarized" },
    });
  });
});
