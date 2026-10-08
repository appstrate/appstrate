// SPDX-License-Identifier: Apache-2.0

/**
 * The platform model catalog: Pi's builtin registry, pinned with the
 * `@earendil-works/pi-ai` version. It is the only source of per-model
 * metadata (label, limits, capabilities, generation controls) and of the
 * catalog price.
 *
 * A provider definition's OFFER is the records of its Pi provider
 * (`catalogProviderId ?? providerId`) served over its `apiShape`. A
 * definition naming no Pi provider (the user-described gateways) offers
 * nothing — its ids are free-form.
 *
 * The live catalog (`model-catalog-overlay.ts`) adds the records a later Pi
 * registry holds and the pinned code can serve, never replacing a bundled one.
 */

import type { CatalogModelEntry } from "@appstrate/shared-types";
import type { ModelCost, ModelProviderDefinition } from "@appstrate/core/module";
import type { PiModelDialect } from "@appstrate/core/sidecar-types";
import {
  MODEL_REASONING_LEVELS,
  type ModelCapabilitySupport,
  type ModelGenerationCapabilities,
} from "@appstrate/core/model-generation";
import type { Api, Model } from "@appstrate/runner-pi";
import {
  findPiModelsById,
  getPiModel,
  isPiProvider,
  listPiModels,
  piModelDialect,
  piReasoningLevels,
  usableRecordMaxTokens,
} from "@appstrate/runner-pi/pi-model";
import { findOverlayModelsById, listOverlayModels } from "./model-catalog-overlay.ts";
import { hasLiveModelSearch } from "./model-search.ts";

type CatalogProvider = Pick<
  ModelProviderDefinition,
  "providerId" | "catalogProviderId" | "apiShape" | "authMode"
>;

/**
 * The bundled registry alone, or it and the live catalog. Boot rules and
 * system models read `bundled`: remote data decides neither whether an
 * instance starts nor what a model the platform pays for costs.
 */
export type CatalogScope = "bundled" | "all";

/** The Pi builtin provider a definition resolves against, or null for a gateway. */
export function piProviderOf(
  def: Pick<CatalogProvider, "providerId" | "catalogProviderId">,
): string | null {
  const key = def.catalogProviderId ?? def.providerId;
  return isPiProvider(key) ? key : null;
}

/**
 * Whether a model bound to this provider must be in its offer: not for a
 * gateway (no Pi provider) nor for a provider searched live.
 */
export function restrictsToOffer(def: CatalogProvider): boolean {
  return piProviderOf(def) !== null && !hasLiveModelSearch(def.providerId);
}

/**
 * The price tiers one request can cross. A subscription (`oauth2`) model is
 * priced from usage summed over requests, where a tier cannot apply (#1552).
 */
export function reachablePriceTiers<T extends { inputTokensAbove: number }>(
  tiers: readonly T[] | undefined,
  contextWindow: number,
): T[] {
  return (tiers ?? []).filter((tier) => tier.inputTokensAbove < contextWindow);
}

function overlayRecords(def: CatalogProvider, provider: string): Model<Api>[] {
  const records = listOverlayModels(provider, def.apiShape);
  if (def.authMode !== "oauth2") return records;
  // `verify:system-models` holds the bundled registry to the same rule at release time.
  return records.filter(
    (record) => reachablePriceTiers(record.cost.tiers, record.contextWindow).length === 0,
  );
}

function catalogRecord(
  def: CatalogProvider,
  modelId: string,
  scope: CatalogScope,
): Model<Api> | undefined {
  const provider = piProviderOf(def);
  if (!provider) return undefined;
  const bundled = getPiModel(provider, modelId, def.apiShape);
  if (bundled || scope === "bundled") return bundled;
  return overlayRecords(def, provider).find((record) => record.id === modelId);
}

export function listCatalogModels(
  def: CatalogProvider,
  scope: CatalogScope = "all",
): Array<CatalogModelEntry & { id: string }> {
  const provider = piProviderOf(def);
  if (!provider) return [];
  return [
    ...listPiModels(provider, def.apiShape),
    ...(scope === "all" ? overlayRecords(def, provider) : []),
  ].map((record) => ({ id: record.id, ...toCatalogEntry(record) }));
}

export function lookupCatalogModel(
  def: CatalogProvider,
  modelId: string,
  scope: CatalogScope = "all",
): CatalogModelEntry | null {
  const record = catalogRecord(def, modelId, scope);
  return record ? toCatalogEntry(record) : null;
}

/** The dialect of the provider's record of `modelId`, or null without one. */
export function lookupCatalogDialect(
  def: CatalogProvider,
  modelId: string,
  scope: CatalogScope = "all",
): PiModelDialect | null {
  const record = catalogRecord(def, modelId, scope);
  return record ? piModelDialect(record) : null;
}

/**
 * What any Pi provider records about `modelId` — never its price: an endpoint
 * serving a vendor's id is not billed at the vendor's rate.
 */
export function describeKnownModel(modelId: string): Omit<CatalogModelEntry, "cost"> | null {
  const record = findPiModelsById(modelId)[0] ?? findOverlayModelsById(modelId)[0];
  if (!record) return null;
  const { cost: _cost, ...described } = toCatalogEntry(record);
  return described;
}

export function toCatalogEntry(record: Model<Api>): CatalogModelEntry {
  return {
    label: record.name,
    contextWindow: record.contextWindow,
    maxTokens: usableRecordMaxTokens(record),
    capabilities: [...record.input, ...(record.reasoning ? ["reasoning"] : [])],
    generation: generationOf(record),
    cost: costOf(record),
  };
}

/**
 * Unpriced: Pi writes zero for a price it does not know (only a `:free` id is
 * really free) and a negative rate for a variable one (OpenRouter's `auto`).
 */
function costOf(record: Model<Api>): ModelCost | null {
  const { input, output, cacheRead, cacheWrite, tiers } = record.cost;
  const rates = [input, output, cacheRead, cacheWrite];
  const tierRates = (tiers ?? []).flatMap((t) => [t.input, t.output, t.cacheRead, t.cacheWrite]);
  if ([...rates, ...tierRates].some((rate) => rate < 0)) return null;
  if (rates.every((rate) => rate === 0) && !record.id.endsWith(":free")) return null;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(tiers?.length ? { tiers: tiers.map((tier) => ({ ...tier })) } : {}),
  };
}

const RESPONSES_APIS: ReadonlySet<string> = new Set(["openai-responses", "openai-codex-responses"]);

interface AnthropicCompat {
  supportsTemperature?: boolean;
  supportsMidConvoEffort?: boolean;
  forceAdaptiveThinking?: boolean;
}

/**
 * Anthropic: the temperature Pi sends (`supportsTemperature`, never with
 * mid-conversation effort, never while thinking) and adaptive thinking.
 * Responses APIs: a reasoning model takes no temperature.
 */
function generationOf(record: Model<Api>): ModelGenerationCapabilities {
  const anthropic = record.api === "anthropic-messages";
  const compat = (anthropic ? record.compat : undefined) as AnthropicCompat | undefined;
  const temperatureSupported = anthropic
    ? (compat?.supportsTemperature ?? true) && compat?.supportsMidConvoEffort !== true
    : !(record.reasoning && RESPONSES_APIS.has(record.api));
  const levels = new Set<string>(piReasoningLevels(record));
  const support = (on: boolean): ModelCapabilitySupport => (on ? "supported" : "unsupported");
  return {
    temperature: support(temperatureSupported),
    reasoning: {
      supported: support(record.reasoning),
      ...(record.reasoning && temperatureSupported
        ? { temperature_compatible: support(!anthropic) }
        : {}),
      adaptive: anthropic ? compat?.forceAdaptiveThinking === true : null,
      levels: Object.fromEntries(
        MODEL_REASONING_LEVELS.map((level) => [level, support(levels.has(level))]),
      ),
    },
  };
}
