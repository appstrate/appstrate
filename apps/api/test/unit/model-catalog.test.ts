// SPDX-License-Identifier: Apache-2.0

/**
 * The catalog IS Pi's pinned registry, so real providers and ids are stable
 * until a deliberate Pi bump. The per-model offer is `model-offer.snapshot.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import type { Api, Model } from "@appstrate/runner-pi";
import { getPiModel } from "@appstrate/runner-pi/pi-model";
import codexModule, { PRO_PLAN_MODEL_IDS } from "@appstrate/module-codex";
import claudeCodeModule from "@appstrate/module-claude-code";
import coreProvidersModule from "../../src/modules/core-providers/index.ts";
import {
  describeKnownModel,
  listCatalogModels,
  lookupCatalogModel,
  piProviderOf,
  restrictsToOffer,
  toCatalogEntry,
} from "../../src/services/model-catalog.ts";

const providers = coreProvidersModule.modelProviders!() as ModelProviderDefinition[];
const codex = codexModule.modelProviders!()[0]!;
const claudeCode = claudeCodeModule.modelProviders!()[0]!;
const provider = (id: string) => providers.find((p) => p.providerId === id)!;
const GATEWAYS = ["openai-compatible", "anthropic-compatible"];

function record(piProvider: string, id: string, api: string): Model<Api> {
  const found = getPiModel(piProvider, id, api);
  if (!found) throw new Error(`Pi has no ${piProvider}/${id} on ${api}`);
  return found;
}

describe("offer", () => {
  it("offers nothing through a user-described gateway", () => {
    for (const id of GATEWAYS) {
      expect(piProviderOf(provider(id))).toBeNull();
      expect(listCatalogModels(provider(id))).toEqual([]);
      expect(lookupCatalogModel(provider(id), "gpt-5.5")).toBeNull();
    }
  });

  it("keeps Codex's Pro-plan models selectable", () => {
    const offered = listCatalogModels(codex).map((m) => m.id);
    for (const id of PRO_PLAN_MODEL_IDS) expect(offered).toContain(id);
  });

  it("features the newest Claude of each family Pi records", () => {
    const newest = (family: string) =>
      listCatalogModels(claudeCode)
        .map((m) => m.id)
        .filter((id) => new RegExp(`^claude-${family}-\\d+(-\\d)?$`).test(id))
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))[0];
    expect(claudeCode.featuredModels).toEqual(
      ["opus", "sonnet", "haiku", "fable"].map((family) => newest(family)!),
    );
  });

  it("looks a model up on the provider's own api shape only", () => {
    const anthropic = provider("anthropic");
    expect(lookupCatalogModel(anthropic, "claude-opus-5")?.label).toBe("Claude Opus 5");
    expect(lookupCatalogModel(anthropic, "no-such-model")).toBeNull();
    // Pi records these Fireworks ids on anthropic-messages only.
    expect(
      lookupCatalogModel(provider("fireworks-ai"), "accounts/fireworks/models/kimi-k2p6"),
    ).toBeNull();
  });
});

describe("restrictsToOffer", () => {
  it("binds a named provider to its offer", () => {
    expect(restrictsToOffer(provider("anthropic"))).toBe(true);
    expect(restrictsToOffer(codex)).toBe(true);
  });

  it("leaves a provider searched live open", () => {
    expect(restrictsToOffer(provider("openrouter"))).toBe(false);
  });

  it("leaves a user-described gateway open", () => {
    for (const id of GATEWAYS) expect(restrictsToOffer(provider(id))).toBe(false);
  });

  it("reads the declaration, not an empty featured list", () => {
    const featuresNothing: ModelProviderDefinition = {
      ...provider("anthropic"),
      featuredModels: [],
    };
    expect(restrictsToOffer(featuresNothing)).toBe(true);
  });
});

describe("toCatalogEntry", () => {
  it("derives Claude Opus 5's adaptive thinking, levels and temperature from Pi", () => {
    const entry = toCatalogEntry(record("anthropic", "claude-opus-5", "anthropic-messages"));
    expect(entry.label).toBe("Claude Opus 5");
    expect(entry.capabilities).toEqual(["text", "image", "reasoning"]);
    expect(entry.generation?.reasoning.adaptive).toBe(true);
    expect(entry.generation?.reasoning.levels).toEqual({
      off: "unsupported",
      minimal: "supported",
      low: "supported",
      medium: "supported",
      high: "supported",
      xhigh: "supported",
      max: "supported",
    });
    // `supportsTemperature: false` on the record.
    expect(entry.generation?.temperature).toBe("unsupported");
  });

  it("keeps temperature on a Claude that accepts it, never alongside thinking", () => {
    const entry = toCatalogEntry(record("anthropic", "claude-sonnet-4-5", "anthropic-messages"));
    expect(entry.generation?.temperature).toBe("supported");
    expect(entry.generation?.reasoning.temperature_compatible).toBe("unsupported");
    expect(entry.generation?.reasoning.adaptive).toBe(false);
  });

  it("refuses temperature on a reasoning model behind a Responses API", () => {
    const gpt = toCatalogEntry(record("openai", "gpt-5.5", "openai-responses"));
    expect(gpt.generation?.temperature).toBe("unsupported");
    expect(gpt.generation?.reasoning.temperature_compatible).toBeUndefined();
    expect(gpt.generation?.reasoning.adaptive).toBeNull();
    const codex = toCatalogEntry(record("openai-codex", "gpt-5.5", "openai-codex-responses"));
    expect(codex.generation?.temperature).toBe("unsupported");
    // A non-reasoning Responses model keeps it.
    const gpt4o = toCatalogEntry(record("openai", "gpt-4o", "openai-responses"));
    expect(gpt4o.generation?.temperature).toBe("supported");
    expect(gpt4o.generation?.reasoning.supported).toBe("unsupported");
    expect(gpt4o.generation?.reasoning.levels).toEqual({
      off: "supported",
      minimal: "unsupported",
      low: "unsupported",
      medium: "unsupported",
      high: "unsupported",
      xhigh: "unsupported",
      max: "unsupported",
    });
  });

  it("carries Pi's long-context price tiers", () => {
    const gpt = record("openai", "gpt-5.5", "openai-responses");
    expect(gpt.cost.tiers?.length).toBeGreaterThan(0);
    expect(toCatalogEntry(gpt).cost?.tiers).toEqual(gpt.cost.tiers!);
  });

  it("drops a response cap that would fill the whole context window", () => {
    const grok = record("xai", "grok-4.6", "openai-responses");
    expect(grok.maxTokens).toBeGreaterThanOrEqual(grok.contextWindow);
    expect(toCatalogEntry(grok).maxTokens).toBeNull();
  });

  const synthetic = (id: string): Model<Api> =>
    ({
      id,
      name: id,
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }) as Model<Api>;

  it("reads an all-zero price as unpriced", () => {
    expect(toCatalogEntry(synthetic("vendor/model")).cost).toBeNull();
  });

  it("reads a negative (variable) rate as unpriced", () => {
    const variable = synthetic("vendor/model");
    variable.cost = { ...variable.cost, input: -1_000_000, output: -1_000_000 };
    expect(toCatalogEntry(variable).cost).toBeNull();
    const tiered = synthetic("vendor/model");
    tiered.cost = {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 1000, input: -1, output: 2, cacheRead: 0, cacheWrite: 0 }],
    };
    expect(toCatalogEntry(tiered).cost).toBeNull();
  });

  it("leaves OpenRouter's variably priced router unpriced", () => {
    const auto = record("openrouter", "openrouter/auto", "openai-completions");
    expect(auto.cost.input).toBeLessThan(0);
    expect(toCatalogEntry(auto).cost).toBeNull();
  });

  it("reads an all-zero price on a `:free` id as a real zero price", () => {
    expect(toCatalogEntry(synthetic("vendor/model:free")).cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("describeKnownModel", () => {
  it("describes an id any Pi provider records, without its price", () => {
    const described = describeKnownModel("claude-opus-5");
    expect(described?.label).toBe("Claude Opus 5");
    expect(described).not.toHaveProperty("cost");
  });

  it("returns null for an id Pi does not know", () => {
    expect(describeKnownModel("definitely-not-a-model")).toBeNull();
  });
});

describe("catalog invariants over every core provider's offer", () => {
  const entries = providers.flatMap((def) =>
    listCatalogModels(def).map((m) => ({ key: `${def.providerId}:${m.id}`, ...m })),
  );

  it("never pairs a response cap with the whole context window", () => {
    expect(
      entries
        .filter((e) => e.maxTokens !== null && e.maxTokens >= e.contextWindow)
        .map((e) => e.key),
    ).toEqual([]);
  });

  it("never advertises reasoning without a selectable effort", () => {
    expect(
      entries
        .filter(
          (e) =>
            e.generation?.reasoning.supported === "supported" &&
            !Object.entries(e.generation.reasoning.levels).some(
              ([level, support]) => level !== "off" && support === "supported",
            ),
        )
        .map((e) => e.key),
    ).toEqual([]);
  });
});
