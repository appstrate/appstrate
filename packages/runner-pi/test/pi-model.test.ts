// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  addRequestUsage,
  buildPiModel,
  clampPiReasoningLevel,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  findPiModelsById,
  getPiModel,
  isPiProvider,
  listPiModels,
  piModelDialect,
  piReasoningLevels,
  piTokenCostUsd,
  usableRecordMaxTokens,
  usageCostUsd,
  type PiTokenCounts,
} from "../src/pi-model.ts";
import { deriveProviderFromApi } from "../src/provider-map.ts";
import { PLATFORM_MODEL_COMPAT, ZERO_MODEL_COST } from "../src/model-compat.ts";
import { capturePayload } from "../src/pi-payload.ts";
import { nativeModel } from "./pi-payload.ts";
import { ALIAS_CLIENT_API_SHAPE } from "@appstrate/core/model-swap";
import type { ModelCost } from "@appstrate/core/module";
import type { TokenUsage } from "@appstrate/core/token-usage";
import { reasoningOffSendsNothing } from "../../ui/src/components/reasoning-off.ts";

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
      thinkingLevelMap: { minimal: null },
      input: ["text"],
      cost: { ...ZERO_MODEL_COST },
      compat: { ...PLATFORM_MODEL_COMPAT },
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
    const spec = {
      id: "claude-fable-5",
      dialect: null,
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
      dialect: null,
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
      dialect: null,
      apiShape: "openai-completions",
      baseUrl: PROXY,
      reasoning: false,
    });
    expect(clampPiReasoningLevel(model, "high")).toBe("off");
  });
});

describe("a reasoning model Pi keeps no record of", () => {
  const gateway = (apiShape: string) =>
    buildPiModel({ id: "my-model", dialect: null, apiShape, baseUrl: PROXY, reasoning: true });
  // Pi's session hands level `off` to the request as no reasoning at all.
  const offPayload = (model: ReturnType<typeof gateway>) => capturePayload(model);

  it("takes off, low, medium and high, never minimal, which a level clamps up from", () => {
    const model = gateway("openai-completions");
    expect(piReasoningLevels(model)).toEqual(["off", "low", "medium", "high"]);
    expect(clampPiReasoningLevel(model, "minimal")).toBe("low");
  });

  it("sends reasoning_effort on chat completions, and nothing at all for off", async () => {
    const model = gateway("openai-completions");
    expect(await capturePayload(model, "high")).toMatchObject({ reasoning_effort: "high" });
    expect(await offPayload(model)).not.toHaveProperty("reasoning_effort");
    expect(reasoningOffSendsNothing({ apiShape: "openai-completions", pi_dialect: null })).toBe(
      true,
    );
  });

  it("disables thinking explicitly for off on the Messages API", async () => {
    const model = gateway("anthropic-messages");
    expect(await offPayload(model)).toMatchObject({ thinking: { type: "disabled" } });
    expect(await capturePayload(model, "low")).toMatchObject({ thinking: { type: "enabled" } });
    expect(reasoningOffSendsNothing({ apiShape: "anthropic-messages", pi_dialect: null })).toBe(
      false,
    );
  });

  it("leaves an alias's client model Pi's own set: the platform clamped the level already", () => {
    const client = buildPiModel({
      id: "alias",
      dialect: null,
      apiShape: ALIAS_CLIENT_API_SHAPE,
      baseUrl: PROXY,
      reasoning: true,
    });
    expect(piReasoningLevels(client)).toContain("minimal");
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

describe("addRequestUsage + usageCostUsd", () => {
  /** One tier at 100k, every rate distinct (a Haiku-shaped card). */
  const ONE_TIER = {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    tiers: [{ inputTokensAbove: 100_000, input: 2, output: 7.5, cacheRead: 0.2, cacheWrite: 2.5 }],
  };
  /** Two tiers, listed out of order: the highest threshold crossed wins. */
  const TWO_TIERS = {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 6.25,
    tiers: [
      { inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
      { inputTokensAbove: 100_000, input: 7, output: 35, cacheRead: 0.7, cacheWrite: 8 },
    ],
  };
  const REQUESTS: PiTokenCounts[] = [
    { input: 1_000, output: 2_000, cacheRead: 10_000, cacheWrite: 100 },
    { input: 50_000, output: 1_000, cacheRead: 50_000, cacheWrite: 0 }, // exactly 100k: base
    { input: 60_000, output: 3_000, cacheRead: 40_000, cacheWrite: 1 }, // 100 001
    { input: 200_000, output: 10_000, cacheRead: 70_000, cacheWrite: 4_000 }, // 274k
    { input: 5_000, output: 500, cacheRead: 150_000, cacheWrite: 2_000 },
    { input: 300_000, output: 8_000, cacheRead: 0, cacheWrite: 0 },
  ];
  const sum = (usage: typeof REQUESTS) =>
    usage.reduce((total, request) => ({
      input: total.input + request.input,
      output: total.output + request.output,
      cacheRead: total.cacheRead + request.cacheRead,
      cacheWrite: total.cacheWrite + request.cacheWrite,
    }));

  for (const [name, cost] of [
    ["one tier", ONE_TIER],
    ["two tiers", TWO_TIERS],
  ] as const) {
    it(`prices summed usage as the sum of its requests (${name})`, () => {
      // Every ordering of a rotating window, so band order never matters.
      for (let shift = 0; shift < REQUESTS.length; shift++) {
        const requests = [...REQUESTS.slice(shift), ...REQUESTS.slice(0, shift)];
        const usage = accumulate(requests, cost);
        const expected = requests.reduce((total, r) => total + piTokenCostUsd(cost, r), 0);
        expect(usageCostUsd(usage, cost)).toBeCloseTo(expected, 10);
        const totals = sum(requests);
        expect(usage).toMatchObject({
          input_tokens: totals.input,
          output_tokens: totals.output,
          cache_read_input_tokens: totals.cacheRead,
          cache_creation_input_tokens: totals.cacheWrite,
        });
      }
    });
  }

  it("keeps one band per tier, holding only the requests priced at it", () => {
    const usage = accumulate(REQUESTS, TWO_TIERS);
    const bands = Object.fromEntries(usage.tiers!.map((b) => [b.input_tokens_above, b]));
    expect(Object.keys(bands).sort()).toEqual(["100000", "272000"]);
    expect(bands[272_000]!.input_tokens).toBe(500_000);
    expect(bands[100_000]!.input_tokens).toBe(65_000);
  });

  it("does not mutate its inputs", () => {
    const first = addRequestUsage({}, REQUESTS[3]!, ONE_TIER);
    const snapshot = structuredClone(first);
    addRequestUsage(first, REQUESTS[3]!, ONE_TIER);
    expect(first).toEqual(snapshot);
  });

  it("counts a bucket Pi's usage omits as 0", () => {
    expect(addRequestUsage({}, { input: 150_000, output: 10 }, ONE_TIER)).toEqual({
      input_tokens: 150_000,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      tiers: [
        {
          input_tokens_above: 100_000,
          input_tokens: 150_000,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      ],
    });
  });

  it("never emits tiers for a card without any, or without a card", () => {
    const flat = { input: 1, output: 5 };
    for (const cost of [flat, null, undefined]) {
      const usage = accumulate(REQUESTS, cost);
      expect(usage).not.toHaveProperty("tiers");
    }
    const usage = accumulate(REQUESTS, flat);
    expect(usageCostUsd(usage, flat)).toBeCloseTo(piTokenCostUsd(flat, sum(REQUESTS)), 10);
  });

  it("prices a band whose threshold names no tier at the base rate", () => {
    const usage = {
      input_tokens: 300_000,
      output_tokens: 1_000,
      tiers: [{ input_tokens_above: 123_456, input_tokens: 300_000, output_tokens: 1_000 }],
    };
    const base = piTokenCostUsd({ ...ONE_TIER, tiers: [] }, piCounts(300_000, 1_000));
    expect(usageCostUsd(usage, ONE_TIER)).toBeCloseTo(base, 10);
  });

  it("clamps a band larger than the totals to them", () => {
    const usage = {
      input_tokens: 200_000,
      output_tokens: 1_000,
      tiers: [{ input_tokens_above: 100_000, input_tokens: 900_000, output_tokens: 9_000 }],
    };
    const tier = { ...ONE_TIER.tiers[0]!, tiers: [] };
    expect(usageCostUsd(usage, ONE_TIER)).toBeCloseTo(
      piTokenCostUsd(tier, piCounts(200_000, 1_000)),
      10,
    );
  });

  function accumulate(requests: PiTokenCounts[], cost: ModelCost | null | undefined): TokenUsage {
    return requests.reduce<TokenUsage>((total, r) => addRequestUsage(total, r, cost), {});
  }

  function piCounts(input: number, output: number): PiTokenCounts {
    return { input, output, cacheRead: 0, cacheWrite: 0 };
  }
});
