// SPDX-License-Identifier: Apache-2.0

// Known limit: quirks Pi keys on `model.id` (Mistral's reasoning format,
// OpenRouter's `anthropic/` prefix) do not fire behind llm-proxy's preset id.
import {
  calculateCost,
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import {
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import type { ModelReasoningLevel } from "@appstrate/core/model-generation";
import { ALIAS_CLIENT_API_SHAPE } from "@appstrate/core/model-swap";
import type { ModelCost, ModelInputModality } from "@appstrate/core/module";
import type { PiModelDialect } from "@appstrate/core/sidecar-types";
import type { TokenUsage } from "@appstrate/core/token-usage";
import { PLATFORM_MODEL_COMPAT, ZERO_MODEL_COST } from "./model-compat.ts";
import { deriveProviderFromApi } from "./provider-map.ts";
import type { Api, Model } from "./pi-sdk.ts";

/**
 * Everything a Pi `Model` is built from. The platform resolves it — the values
 * and the record's {@link PiModelDialect} — and nothing here reads the registry.
 */
export interface PiModelSpec {
  /** Wire id: a preset id through llm-proxy, else the upstream id. */
  id: string;
  apiShape: string;
  /** Pi builtin provider key; null for a gateway. */
  piProvider?: string | null;
  /** The record's dialect; null for a model Pi keeps no record of, or the alias client. */
  dialect: PiModelDialect | null;
  baseUrl: string;
  reasoning?: boolean | null;
  input?: readonly ModelInputModality[] | null;
  cost?: ModelCost | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  headers?: Record<string, string>;
}

/**
 * Limits for a model nothing else sizes. Never left undefined: pi-ai clamps
 * `maxTokens` against the window, and NaN goes out as `"max_tokens": null`.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

/** A record's output cap, or null when it fills the window: no room left for the prompt. */
export function usableRecordMaxTokens(
  record: Pick<Model<Api>, "contextWindow" | "maxTokens">,
): number | null {
  return record.maxTokens < record.contextWindow ? record.maxTokens : null;
}

const PI_PROVIDERS: ReadonlySet<string> = new Set(getBuiltinProviders());

export function isPiProvider(key: string): boolean {
  return PI_PROVIDERS.has(key);
}

/** The records of Pi provider `piProvider` served over `api`; `[]` for an unknown provider. */
export function listPiModels(piProvider: string, api: string): Model<Api>[] {
  if (!isPiProvider(piProvider)) return [];
  const records = getBuiltinModels(piProvider as BuiltinProvider) as Model<Api>[];
  return records.filter((record) => record.api === api);
}

export function getPiModel(piProvider: string, id: string, api: string): Model<Api> | undefined {
  if (!isPiProvider(piProvider)) return undefined;
  const record = getBuiltinModel(piProvider as BuiltinProvider, id as never) as
    Model<Api> | undefined;
  // `id` indexes a plain object: an inherited key (`constructor`) is no record.
  return record?.id === id && record.api === api ? record : undefined;
}

/** Every provider's records served over `api`. */
export function listPiModelsOfApi(api: string): Model<Api>[] {
  return [...PI_PROVIDERS].flatMap((provider) => listPiModels(provider, api));
}

/** Every provider's record of `id`, whatever its API shape. */
export function findPiModelsById(id: string): Model<Api>[] {
  return [...PI_PROVIDERS].flatMap((provider) => {
    const record = getBuiltinModel(provider as BuiltinProvider, id as never) as
      Model<Api> | undefined;
    return record?.id === id ? [record] : [];
  });
}

export function piReasoningLevels(model: Model<Api>): ModelReasoningLevel[] {
  return getSupportedThinkingLevels(model);
}

/** The level `model` really takes for `level`: Pi's nearest supported one, upward first. */
export function clampPiReasoningLevel(
  model: Model<Api>,
  level: ModelReasoningLevel,
): ModelReasoningLevel {
  return clampThinkingLevel(model, level);
}

/** Pi's token buckets: `input` is net of the two cache buckets. */
export interface PiTokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The {@link PiTokenCounts} of a wire {@link TokenUsage} or band; absent → 0. */
export function piTokenCounts(usage: Omit<TokenUsage, "tiers">): PiTokenCounts {
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * USD cost of one request's tokens, `cost.tiers` honoured. Pi's
 * `calculateCost` writes into the usage it is given, so each call gets a fresh one.
 */
export function piTokenCostUsd(cost: ModelCost, usage: PiTokenCounts): number {
  const rates = { ...cost, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0 };
  const { input, output, cacheRead, cacheWrite } = usage;
  const tokens = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { ...ZERO_MODEL_COST, total: 0 },
  };
  // `calculateCost` reads nothing of the model but its `cost`.
  return calculateCost({ cost: rates } as Model<Api>, tokens).total;
}

/** The tier threshold `calculateCost` prices `request` at (null: base): pi-ai's private loop. */
function pricedTierThreshold(cost: ModelCost, request: PiTokenCounts): number | null {
  const prompt = request.input + request.cacheRead + request.cacheWrite;
  let matched: number | null = null;
  for (const { inputTokensAbove } of cost.tiers ?? []) {
    if (prompt > inputTokensAbove && inputTokensAbove > (matched ?? -1)) matched = inputTokensAbove;
  }
  return matched;
}

function addCounts(
  usage: Omit<TokenUsage, "tiers">,
  request: PiTokenCounts,
): Required<Omit<TokenUsage, "tiers">> {
  return {
    input_tokens: (usage.input_tokens ?? 0) + request.input,
    output_tokens: (usage.output_tokens ?? 0) + request.output,
    cache_creation_input_tokens: (usage.cache_creation_input_tokens ?? 0) + request.cacheWrite,
    cache_read_input_tokens: (usage.cache_read_input_tokens ?? 0) + request.cacheRead,
  };
}

/** `total` plus one request, added to the counters and to the band of its tier. Pure. */
export function addRequestUsage(
  total: TokenUsage,
  usage: Partial<PiTokenCounts>,
  cost: ModelCost | null | undefined,
): TokenUsage {
  const request: PiTokenCounts = {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
  };
  const next: TokenUsage = { ...total, ...addCounts(total, request) };
  const threshold = cost ? pricedTierThreshold(cost, request) : null;
  if (threshold === null) return next;
  const bands = total.tiers ?? [];
  const band = bands.find((b) => b.input_tokens_above === threshold);
  next.tiers = band
    ? bands.map((b) => (b === band ? { ...b, ...addCounts(b, request) } : b))
    : [...bands, { input_tokens_above: threshold, ...addCounts({}, request) }];
  return next;
}

/**
 * USD cost of usage summed by {@link addRequestUsage}: each band at its tier, the
 * rest at base. Unknown tiers price at base and bands are clamped: never throws.
 */
export function usageCostUsd(usage: TokenUsage, cost: ModelCost): number {
  const base: ModelCost = { ...cost, tiers: [] };
  const rest = piTokenCounts(usage);
  let total = 0;
  for (const band of usage.tiers ?? []) {
    const counts = piTokenCounts(band);
    const share = {} as PiTokenCounts;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      share[key] = Math.max(0, Math.min(counts[key], rest[key]));
      rest[key] -= share[key];
    }
    const tier = cost.tiers?.find((t) => t.inputTokensAbove === band.input_tokens_above);
    total += piTokenCostUsd(tier ? { ...tier, tiers: [] } : base, share);
  }
  return total + piTokenCostUsd(base, rest);
}

/** The dialect of a registry record — see {@link PiModelDialect}. */
export function piModelDialect(record: Model<Api>): PiModelDialect {
  return {
    name: record.name,
    ...(record.thinkingLevelMap ? { thinkingLevelMap: record.thinkingLevelMap } : {}),
    ...(record.compat ? { compat: record.compat as Record<string, unknown> } : {}),
  };
}

/**
 * The levels of a model Pi keeps no record of: those every reasoning backend
 * takes. Pi sends `minimal` verbatim, and OpenAI's o-series and gpt-5.1+ refuse
 * it. An alias's client model has no record by design and keeps Pi's set: the
 * platform clamps its level to the backing before the run.
 */
const UNRECORDED_THINKING_LEVEL_MAP = { minimal: null } as const;

function thinkingLevelMapOf(spec: PiModelSpec): Model<Api>["thinkingLevelMap"] {
  if (spec.dialect) return spec.dialect.thinkingLevelMap;
  return spec.apiShape === ALIAS_CLIENT_API_SHAPE ? undefined : UNRECORDED_THINKING_LEVEL_MAP;
}

export function buildPiModel(spec: PiModelSpec): Model<Api> {
  const dialect = spec.dialect;
  const thinkingLevelMap = thinkingLevelMapOf(spec);
  return {
    id: spec.id,
    name: dialect?.name ?? spec.id,
    api: spec.apiShape as Api,
    provider: spec.piProvider ?? deriveProviderFromApi(spec.apiShape),
    baseUrl: spec.baseUrl,
    reasoning: spec.reasoning ?? false,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: spec.input ? [...spec.input] : ["text"],
    cost: { ...ZERO_MODEL_COST, ...spec.cost },
    compat: { ...dialect?.compat, ...PLATFORM_MODEL_COMPAT },
    contextWindow: spec.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(spec.headers ? { headers: spec.headers } : {}),
  } as Model<Api>;
}
