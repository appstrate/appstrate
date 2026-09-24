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
import { PLATFORM_MODEL_COMPAT, ZERO_MODEL_COST } from "./model-compat.ts";
import { deriveProviderFromApi } from "./provider-map.ts";
import type { Api, Model } from "./pi-sdk.ts";

/**
 * Pi's registry record is the model's metadata and dialect; the spec adds the
 * wire fields and the org's EXPLICIT overrides (null/undefined = none).
 */
export interface PiModelSpec {
  /** Wire id: a preset id through llm-proxy, else the upstream id. */
  id: string;
  registryModelId?: string | null;
  apiShape: string;
  /** Pi builtin provider key; null for a gateway, which gets no record. */
  piProvider?: string | null;
  baseUrl: string;
  reasoning?: boolean | null;
  input?: readonly ModelInputModality[] | null;
  cost?: ModelCost | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  headers?: Record<string, string>;
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

export function buildPiModel(spec: PiModelSpec): Model<Api> {
  const record =
    spec.piProvider && spec.registryModelId
      ? getPiModel(spec.piProvider, spec.registryModelId, spec.apiShape)
      : undefined;
  const input = spec.input ?? record?.input;
  return {
    id: spec.id,
    name: record?.name ?? spec.id,
    api: spec.apiShape as Api,
    provider: spec.piProvider ?? deriveProviderFromApi(spec.apiShape),
    baseUrl: spec.baseUrl,
    reasoning: spec.reasoning ?? record?.reasoning ?? false,
    ...(record?.thinkingLevelMap ? { thinkingLevelMap: record.thinkingLevelMap } : {}),
    input: input ? [...input] : ["text"],
    // An override replaces the record's card whole, tiers included.
    cost: spec.cost
      ? { ...ZERO_MODEL_COST, ...spec.cost }
      : (record?.cost ?? { ...ZERO_MODEL_COST }),
    compat: { ...record?.compat, ...PLATFORM_MODEL_COMPAT },
    contextWindow: spec.contextWindow ?? record?.contextWindow,
    maxTokens: spec.maxTokens ?? record?.maxTokens,
    ...(spec.headers ? { headers: spec.headers } : {}),
  } as Model<Api>;
}
