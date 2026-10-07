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
import type { ModelCost, ModelInputModality } from "@appstrate/core/module";
import type { PiModelDialect } from "@appstrate/core/sidecar-types";
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
  /** The record's dialect; null or absent for a model Pi keeps no record of. */
  dialect?: PiModelDialect | null;
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

/**
 * USD cost of one request's tokens, `cost.tiers` honoured. Pi's
 * `calculateCost` writes into the usage it is given, so each call gets a fresh one.
 */
export function piTokenCostUsd(
  cost: ModelCost,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
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

/** The dialect of a registry record — see {@link PiModelDialect}. */
export function piModelDialect(record: Model<Api>): PiModelDialect {
  return {
    name: record.name,
    ...(record.thinkingLevelMap ? { thinkingLevelMap: record.thinkingLevelMap } : {}),
    ...(record.compat ? { compat: record.compat as Record<string, unknown> } : {}),
  };
}

export function buildPiModel(spec: PiModelSpec): Model<Api> {
  const dialect = spec.dialect;
  return {
    id: spec.id,
    name: dialect?.name ?? spec.id,
    api: spec.apiShape as Api,
    provider: spec.piProvider ?? deriveProviderFromApi(spec.apiShape),
    baseUrl: spec.baseUrl,
    reasoning: spec.reasoning ?? false,
    ...(dialect?.thinkingLevelMap ? { thinkingLevelMap: dialect.thinkingLevelMap } : {}),
    input: spec.input ? [...spec.input] : ["text"],
    cost: { ...ZERO_MODEL_COST, ...spec.cost },
    compat: { ...dialect?.compat, ...PLATFORM_MODEL_COMPAT },
    contextWindow: spec.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: spec.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(spec.headers ? { headers: spec.headers } : {}),
  } as Model<Api>;
}
