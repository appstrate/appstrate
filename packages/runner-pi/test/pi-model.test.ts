// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  buildPiModel,
  clampPiReasoningLevel,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  findPiModelsById,
  getPiModel,
  isPiProvider,
  listPiModels,
  piModelDialect,
  piTokenCostUsd,
  usableRecordMaxTokens,
} from "../src/pi-model.ts";
import { deriveProviderFromApi } from "../src/provider-map.ts";
import { PLATFORM_MODEL_COMPAT, ZERO_MODEL_COST } from "../src/model-compat.ts";
import { capturePayload, nativeModel } from "./pi-payload.ts";

const PROXY = "https://appstrate.test/api/llm-proxy/openai-responses/v1";

describe("buildPiModel", () => {
  // Pi's `claude-fable-5` record lists server-side fallbacks: the vendor could
  // answer from another model while llm-proxy bills the requested one.
  it("never sends a record's fallback models", async () => {
    const native = nativeModel("anthropic", "claude-fable-5")!;
    expect(native.compat).toHaveProperty("allowedFallbackModels");
    expect(await capturePayload(native)).toHaveProperty("fallbacks");

    const model = buildPiModel({
      id: "preset_fable",
      dialect: piModelDialect(native),
      apiShape: "anthropic-messages",
      piProvider: "anthropic",
      baseUrl: "https://appstrate.test/api/llm-proxy/anthropic-messages",
    });
    expect(model.compat).toMatchObject({ forceAdaptiveThinking: true });
    expect(await capturePayload(model)).not.toHaveProperty("fallbacks");
  });

  // A record's Anthropic cache markers make OpenRouter bill cache writes the
  // metering prices at $0; the proxied model keeps pi-ai's own detection.
  it("never sends a record's cache-control format", async () => {
    const native = nativeModel("openrouter", "~anthropic/claude-sonnet-latest")!;
    const spec = {
      id: "preset_or",
      dialect: piModelDialect(native),
      apiShape: "openai-completions",
      piProvider: "openrouter",
      baseUrl: "https://appstrate.test/api/llm-proxy/openai-completions/v1",
    };
    expect(native.compat).toMatchObject({ cacheControlFormat: "anthropic" });
    expect(JSON.stringify(await capturePayload({ ...native, id: spec.id }))).toContain(
      "cache_control",
    );

    const model = buildPiModel(spec);
    expect(model.compat).toHaveProperty("thinkingFormat", "openrouter");
    expect(JSON.stringify(await capturePayload(model))).not.toContain("cache_control");
  });

  it("rebuilds a record from its dialect and its resolved values, the dialect off the wire", () => {
    const record = getPiModel("openai", "gpt-5.5", "openai-responses")!;
    const model = buildPiModel({
      id: "preset_gpt",
      // As a container, a sidecar or a CLI receives it: through JSON.
      dialect: JSON.parse(JSON.stringify(piModelDialect(record))),
      apiShape: "openai-responses",
      piProvider: "openai",
      baseUrl: PROXY,
      reasoning: record.reasoning,
      input: record.input,
      cost: record.cost,
      contextWindow: record.contextWindow,
      maxTokens: record.maxTokens,
    });
    expect(model).toEqual({
      id: "preset_gpt",
      name: record.name,
      api: "openai-responses",
      provider: "openai",
      baseUrl: PROXY,
      reasoning: true,
      thinkingLevelMap: record.thinkingLevelMap,
      input: record.input,
      cost: record.cost,
      compat: { ...record.compat, ...PLATFORM_MODEL_COMPAT },
      contextWindow: record.contextWindow,
      maxTokens: record.maxTokens,
    } as never);
    expect(model.cost.tiers).toHaveLength(1);
  });

  it("lets an explicit org override win, the cost as a whole", () => {
    const cost = { input: 1, output: 2 };
    const model = buildPiModel({
      id: "preset_gpt",
      dialect: piModelDialect(getPiModel("openai", "gpt-5.5", "openai-responses")!),
      apiShape: "openai-responses",
      piProvider: "openai",
      baseUrl: PROXY,
      reasoning: false,
      input: ["text"],
      cost,
      contextWindow: 100_000,
      maxTokens: 4_096,
    });
    expect(model).toMatchObject({
      reasoning: false,
      input: ["text"],
      cost,
      contextWindow: 100_000,
      maxTokens: 4_096,
    });
    expect(model.cost.tiers).toBeUndefined();
  });

  // The builder reads no registry: an id Pi records, under its own provider,
  // gets nothing of that record unless the platform hands its dialect over.
  it("looks nothing up: without a dialect a recorded id is a bare model", () => {
    expect(getPiModel("anthropic", "claude-fable-5", "anthropic-messages")).toBeDefined();
    const bare = {
      id: "claude-fable-5",
      name: "claude-fable-5",
      api: "anthropic-messages",
      baseUrl: "https://gateway.example",
      reasoning: false,
      input: ["text"],
      cost: { ...ZERO_MODEL_COST },
      compat: { ...PLATFORM_MODEL_COMPAT },
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
    const spec = {
      id: "claude-fable-5",
      apiShape: "anthropic-messages",
      baseUrl: "https://gateway.example",
    };
    expect(buildPiModel({ ...spec, piProvider: "anthropic" })).toEqual({
      ...bare,
      provider: "anthropic",
    } as never);
    // A gateway names no Pi provider: the api shape's generic key.
    expect(buildPiModel({ ...spec, piProvider: null })).toEqual({
      ...bare,
      provider: deriveProviderFromApi("anthropic-messages"),
    } as never);
  });

  // pi-ai clamps `maxTokens` against the window: an undefined one is NaN on the wire.
  it("gives a model with no record and no limits the platform defaults", () => {
    const model = buildPiModel({
      id: "gw-model",
      apiShape: "openai-completions",
      piProvider: null,
      baseUrl: "https://gateway.example",
      contextWindow: 32_000,
    });
    expect(model).toMatchObject({ contextWindow: 32_000, maxTokens: DEFAULT_MAX_TOKENS });
  });
});

describe("usableRecordMaxTokens", () => {
  it("keeps a cap below the window and refuses one that fills it", () => {
    expect(usableRecordMaxTokens({ contextWindow: 200_000, maxTokens: 64_000 })).toBe(64_000);
    expect(usableRecordMaxTokens({ contextWindow: 128_000, maxTokens: 128_000 })).toBeNull();
  });
});

describe("Pi registry accessors", () => {
  it("lists a provider's records of one API shape", () => {
    expect(listPiModels("openai-codex", "openai-codex-responses").map((m) => m.id)).toEqual([
      "gpt-5.3-codex-spark",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6.1-sol",
    ]);
    expect(listPiModels("xai", "openai-completions")).toEqual([]);
    expect(listPiModels("xai", "openai-responses")).toHaveLength(4);
    expect(listPiModels("not-a-pi-provider", "openai-completions")).toEqual([]);
  });

  it("reads one record only under its own API shape", () => {
    expect(getPiModel("xai", "grok-4.3", "openai-responses")?.id).toBe("grok-4.3");
    expect(getPiModel("xai", "grok-4.3", "openai-completions")).toBeUndefined();
    expect(getPiModel("openai", "not-a-model", "openai-responses")).toBeUndefined();
    expect(getPiModel("not-a-pi-provider", "grok-4.3", "openai-responses")).toBeUndefined();
  });

  it("finds an id across providers", () => {
    const providers = findPiModelsById("gpt-5.5").map((m) => m.provider);
    expect(providers).toEqual(expect.arrayContaining(["openai", "openai-codex"]));
    expect(findPiModelsById("not-a-model")).toEqual([]);
  });

  it("knows Pi's provider keys", () => {
    expect(isPiProvider("openai-codex")).toBe(true);
    expect(isPiProvider("codex")).toBe(false);
    expect(isPiProvider("toString")).toBe(false);
  });
});

describe("clampPiReasoningLevel", () => {
  it("maps a level to the model's nearest supported one, Pi's rule", () => {
    // deepseek-flash: off, low, high, max — `medium` goes up, not down.
    const flash = getPiModel("deepseek", "deepseek-flash", "openai-completions")!;
    expect(clampPiReasoningLevel(flash, "medium")).toBe("high");
    expect(clampPiReasoningLevel(flash, "minimal")).toBe("low");
    expect(clampPiReasoningLevel(flash, "high")).toBe("high");
  });

  it("answers off for a model without reasoning", () => {
    const model = buildPiModel({
      id: "plain",
      apiShape: "openai-completions",
      baseUrl: PROXY,
      reasoning: false,
    });
    expect(clampPiReasoningLevel(model, "high")).toBe("off");
  });
});

describe("piTokenCostUsd", () => {
  // gpt-5.5: $5 / $30 / $0.5 cache-read per 1M; above 272k input tokens $10 / $45 / $1.
  const cost = getPiModel("openai", "gpt-5.5", "openai-responses")!.cost;
  const usage = { input: 0, output: 1_000, cacheRead: 0, cacheWrite: 0 };

  it("prices at the base rate up to the tier threshold", () => {
    expect(piTokenCostUsd(cost, { ...usage, input: 200_000 })).toBeCloseTo(1.03, 10);
  });

  it("prices the whole request at the tier rate above it, cache reads included", () => {
    expect(piTokenCostUsd(cost, { ...usage, input: 300_000 })).toBeCloseTo(3.045, 10);
    expect(piTokenCostUsd(cost, { ...usage, input: 200_000, cacheRead: 100_000 })).toBeCloseTo(
      2.145,
      10,
    );
  });

  it("does not leak state between calls", () => {
    const request = { ...usage, input: 300_000 };
    expect(piTokenCostUsd(cost, request)).toBe(piTokenCostUsd(cost, request));
    expect(request).toEqual({ ...usage, input: 300_000 });
  });

  it("prices an absent cache rate at zero", () => {
    const flat = { input: 1, output: 2 };
    const million = { input: 1_000_000, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
    expect(piTokenCostUsd(flat, million)).toBeCloseTo(1, 10);
  });
});
