// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 4 (model alias) — the featured-models generator must never surface a
 * model-alias backing. `aliasedBackings()` unions an explicit env list with the
 * aliased entries declared in SYSTEM_PROVIDER_KEYS; `buildFeatured()` filters
 * them out. Exclusion lives in the generator (not the JSON) so the weekly
 * auto-regen keeps dropping them.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  aliasedBackings,
  buildFeatured,
  countCacheRates,
  coverageRow,
  deriveGenerationCapabilities,
  formatCoverageSummary,
  projectEntry,
  type CoverageRow,
} from "../refresh-pricing-catalog.ts";

const ORIG_EXCLUDE = process.env.FEATURED_MODELS_EXCLUDE;
const ORIG_KEYS = process.env.SYSTEM_PROVIDER_KEYS;

afterEach(() => {
  // Restore — bun:test shares one process; leaking env poisons sibling files.
  if (ORIG_EXCLUDE === undefined) delete process.env.FEATURED_MODELS_EXCLUDE;
  else process.env.FEATURED_MODELS_EXCLUDE = ORIG_EXCLUDE;
  if (ORIG_KEYS === undefined) delete process.env.SYSTEM_PROVIDER_KEYS;
  else process.env.SYSTEM_PROVIDER_KEYS = ORIG_KEYS;
});

// Minimal stand-ins for the script's internal shapes (only the fields the
// functions read).
const snap = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, {} as never]));
const md = (entries: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(entries).map(([id, release_date]) => [
      id,
      { tool_call: true, release_date } as never,
    ]),
  );

describe("aliasedBackings", () => {
  it("reads the explicit FEATURED_MODELS_EXCLUDE list", () => {
    delete process.env.SYSTEM_PROVIDER_KEYS;
    process.env.FEATURED_MODELS_EXCLUDE = "deepseek-chat, gpt-4o-secret";
    const out = aliasedBackings();
    expect(out.has("deepseek-chat")).toBe(true);
    expect(out.has("gpt-4o-secret")).toBe(true);
  });

  it("derives backings from aliased SYSTEM_PROVIDER_KEYS entries (only aliased ones)", () => {
    delete process.env.FEATURED_MODELS_EXCLUDE;
    process.env.SYSTEM_PROVIDER_KEYS = JSON.stringify([
      {
        id: "k",
        providerId: "deepseek",
        apiKey: "x",
        models: [
          { id: "appstrate-medium", modelId: "deepseek-chat", aliased: true },
          { id: "plain", modelId: "deepseek-reasoner" },
        ],
      },
    ]);
    const out = aliasedBackings();
    expect(out.has("deepseek-chat")).toBe(true);
    expect(out.has("deepseek-reasoner")).toBe(false);
  });

  it("survives a malformed SYSTEM_PROVIDER_KEYS (explicit list still applies)", () => {
    process.env.SYSTEM_PROVIDER_KEYS = "{not json";
    process.env.FEATURED_MODELS_EXCLUDE = "deepseek-chat";
    const out = aliasedBackings();
    expect(out.has("deepseek-chat")).toBe(true);
  });
});

describe("buildFeatured", () => {
  it("excludes alias backings while keeping other models, capped at FEATURED_COUNT", () => {
    const snapshot = snap("a", "secret", "b", "c", "d");
    const models = md({
      a: "2026-01-04",
      secret: "2026-01-03",
      b: "2026-01-02",
      c: "2026-01-01",
      d: "2025-12-31",
    });
    const out = buildFeatured("deepseek", snapshot, models, new Set(["secret"]));
    expect(out).not.toContain("secret");
    // Newest-first, the backing dropped, capped at 3.
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("is a no-op filter when nothing is excluded", () => {
    const snapshot = snap("a", "b");
    const models = md({ a: "2026-01-02", b: "2026-01-01" });
    expect(buildFeatured("openai", snapshot, models, new Set())).toEqual(["a", "b"]);
  });
});

/**
 * Cache-rate coverage — `cost.cacheRead` / `cost.cacheWrite` are only vendored
 * when LiteLLM upstream carries them, so coverage drifts silently and a model
 * without `cacheRead` prices its cached tokens at zero. These summaries are what
 * put the drift in front of a reviewer in the weekly PR.
 */
const entry = (cost: Record<string, number>) =>
  ({ contextWindow: 1, maxTokens: null, capabilities: [], cost }) as never;
const catalog = (...costs: Record<string, number>[]) =>
  Object.fromEntries(costs.map((c, i) => [`m${i}`, entry(c)]));

describe("countCacheRates", () => {
  it("counts each optional cache rate independently", () => {
    const snapshot = catalog(
      { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.2 },
      { input: 1, output: 2, cacheRead: 0.1 },
      { input: 1, output: 2 },
    );
    expect(countCacheRates(snapshot)).toEqual({ entries: 3, cacheRead: 2, cacheWrite: 1 });
  });

  it("counts an explicit zero rate as covered — 'rate is 0' is not 'no rate'", () => {
    expect(countCacheRates(catalog({ input: 1, output: 2, cacheRead: 0 }))).toEqual({
      entries: 1,
      cacheRead: 1,
      cacheWrite: 0,
    });
  });

  it("reports an empty provider without dividing by zero downstream", () => {
    expect(countCacheRates({})).toEqual({ entries: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("coverageRow", () => {
  it("carries the previous counts so the summary can show a delta", () => {
    const local = catalog({ input: 1, output: 2, cacheRead: 0.1 }, { input: 1, output: 2 });
    const upstream = catalog(
      { input: 1, output: 2, cacheRead: 0.1 },
      { input: 1, output: 2, cacheRead: 0.1 },
      { input: 1, output: 2, cacheWrite: 1 },
    );
    expect(coverageRow("openai", local, upstream)).toEqual({
      provider: "openai",
      entries: 3,
      cacheRead: 2,
      cacheWrite: 1,
      prevEntries: 2,
      prevCacheRead: 1,
      prevCacheWrite: 0,
    });
  });
});

describe("formatCoverageSummary", () => {
  const row = (over: Partial<CoverageRow>): CoverageRow => ({
    provider: "p",
    entries: 10,
    cacheRead: 10,
    cacheWrite: 10,
    prevEntries: 10,
    prevCacheRead: 10,
    prevCacheWrite: 10,
    ...over,
  });

  it("renders counts, shares and signed deltas", () => {
    const md = formatCoverageSummary([
      row({
        provider: "openai",
        entries: 89,
        cacheRead: 58,
        cacheWrite: 5,
        prevEntries: 88,
        prevCacheRead: 57,
        prevCacheWrite: 5,
      }),
    ]);
    expect(md).toContain("| `openai` | 89 | +1 | 58 (65%) | +1 | 5 (6%) | · |");
  });

  it("shows a negative delta when models lose their cache rate upstream", () => {
    const md = formatCoverageSummary([row({ provider: "xai", cacheRead: 8, prevCacheRead: 12 })]);
    expect(md).toContain("| 8 (80%) | -4 |");
  });

  it("flags a provider with zero cacheRead coverage in the row and in a footnote", () => {
    const md = formatCoverageSummary([
      row({
        provider: "mistral",
        entries: 51,
        cacheRead: 0,
        cacheWrite: 0,
        prevEntries: 51,
        prevCacheRead: 0,
        prevCacheWrite: 0,
      }),
      row({
        provider: "anthropic",
        entries: 24,
        cacheRead: 24,
        cacheWrite: 24,
        prevEntries: 24,
        prevCacheRead: 24,
        prevCacheWrite: 24,
      }),
    ]);
    expect(md).toContain("| 0 (0%) ⚠️ |");
    expect(md).toContain("No `cacheRead` rate at all: `mistral`");
    expect(md).not.toContain("`anthropic`, ");
  });

  it("omits the footnote when every provider carries a cacheRead rate", () => {
    const md = formatCoverageSummary([row({ provider: "anthropic" })]);
    expect(md).not.toContain("No `cacheRead` rate at all");
  });

  it("renders an empty provider as — rather than NaN%", () => {
    const md = formatCoverageSummary([
      row({
        provider: "new",
        entries: 0,
        cacheRead: 0,
        cacheWrite: 0,
        prevEntries: 0,
        prevCacheRead: 0,
        prevCacheWrite: 0,
      }),
    ]);
    expect(md).toContain("| `new` | 0 | · | — | · | — | · |");
    expect(md).not.toContain("NaN");
  });
});

describe("generation capabilities", () => {
  it("normalizes LiteLLM reasoning efforts and supported request parameters", () => {
    expect(
      deriveGenerationCapabilities({
        supports_reasoning: true,
        supports_none_reasoning_effort: true,
        supports_minimal_reasoning_effort: false,
        supports_low_reasoning_effort: true,
        supports_xhigh_reasoning_effort: false,
        supports_adaptive_thinking: true,
        _appstrate_supported_openai_params: ["temperature", "tools"],
      }),
    ).toEqual({
      temperature: "supported",
      temperatureWithReasoning: "unknown",
      reasoning: {
        supported: "supported",
        adaptive: true,
        levels: {
          off: "supported",
          minimal: "unsupported",
          low: "supported",
          medium: "supported",
          high: "supported",
          xhigh: "unsupported",
        },
      },
    });
  });

  it("keeps absent upstream facts unknown instead of guessing", () => {
    expect(deriveGenerationCapabilities({})).toEqual({
      temperature: "unknown",
      temperatureWithReasoning: "unknown",
      reasoning: {
        supported: "unknown",
        adaptive: null,
        levels: {
          off: "unknown",
          minimal: "unknown",
          low: "unknown",
          medium: "unknown",
          high: "unknown",
          xhigh: "unknown",
        },
      },
    });
  });

  it("uses LiteLLM's supported parameter list as a reasoning capability fact", () => {
    const capabilities = deriveGenerationCapabilities({
      _appstrate_supported_openai_params: ["reasoning_effort"],
    });
    expect(capabilities.reasoning.supported).toBe("supported");
    expect(capabilities.reasoning.levels.low).toBe("supported");
    expect(capabilities.reasoning.levels.medium).toBe("supported");
    expect(capabilities.reasoning.levels.high).toBe("supported");
  });

  it("maps LiteLLM's max effort to Appstrate's portable xhigh level", () => {
    const capabilities = deriveGenerationCapabilities({
      supports_reasoning: true,
      supports_max_reasoning_effort: true,
    });
    expect(capabilities.reasoning.levels.xhigh).toBe("supported");
  });

  it("vendors the normalized generation block with pricing", () => {
    const projected = projectEntry("reasoner", {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      max_input_tokens: 10_000,
      supports_reasoning: true,
      supports_sampling_params: false,
    });
    expect(projected?.generation.temperature).toBe("unsupported");
    expect(projected?.generation.reasoning.supported).toBe("supported");
  });

  it("keeps the legacy runtime reasoning flag aligned with the normalized source", () => {
    const projected = projectEntry("reasoner", {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      max_input_tokens: 10_000,
      _appstrate_supported_openai_params: ["reasoning_effort"],
    });
    expect(projected?.generation.reasoning.supported).toBe("supported");
    expect(projected?.capabilities).toContain("reasoning");
  });
});
