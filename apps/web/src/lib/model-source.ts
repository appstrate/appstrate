// SPDX-License-Identifier: Apache-2.0

/**
 * Where the model form's pick list comes from, and the one row shape all three
 * sources produce. Descriptions serve the picker; endpoint capabilities alone
 * may become overrides when adding a discovered model.
 */

import type { ModelCost } from "@appstrate/core/module";
import type {
  DiscoveredModel,
  ProviderRegistryEntry,
} from "../hooks/use-model-provider-credentials";
import type { OpenRouterModel } from "../hooks/use-models";
import { catalogValues, type CatalogModelValues } from "./row-overrides-catalog";

export type ModelSource = "catalog" | "discover" | "search";

/**
 * Which listing answers for a provider. `search` is OpenRouter alone: its live
 * search returns the billing rate, which `POST /discover` never does. `catalog`
 * covers every entry the vendored catalog describes and every oauth2 one (a
 * subscription's listing is what the plan serves, and discovery refuses to
 * spend a subscription token). `discover` is the rest.
 */
export function modelSource(
  provider:
    | (Pick<ProviderRegistryEntry, "providerId" | "authMode"> & { models: readonly unknown[] })
    | undefined,
): ModelSource | null {
  if (!provider) return null;
  if (provider.providerId === "openrouter") return "search";
  if (provider.authMode === "oauth2" || provider.models.length > 0) return "catalog";
  return "discover";
}

/** One offered model, whatever listing described it. */
export interface ModelPickRow {
  id: string;
  label: string | null;
  contextWindow: number | null;
  maxTokens: number | null;
  input: string[] | null;
  reasoning: boolean | null;
  /** Who described the row — rendered as a badge. */
  source: "endpoint" | "catalog" | null;
  endpointCapabilities: Partial<
    Pick<ModelPickRow, "input" | "contextWindow" | "maxTokens" | "reasoning">
  >;
  cost: ModelCost | null;
  /** The listing it came from: what the batch is allowed to send. */
  origin: ModelSource;
  /** Catalog-only: the curated group. */
  featured: boolean;
}

function pickRow(row: Partial<ModelPickRow> & Pick<ModelPickRow, "id" | "origin">): ModelPickRow {
  return {
    label: null,
    contextWindow: null,
    maxTokens: null,
    input: null,
    reasoning: null,
    source: null,
    endpointCapabilities: {},
    cost: null,
    featured: false,
    ...row,
  };
}

export interface CatalogModelEntry extends CatalogModelValues {
  id: string;
  label: string;
  featured: boolean;
}

export function catalogRows(entries: readonly CatalogModelEntry[]): ModelPickRow[] {
  return entries.map((m) =>
    pickRow({
      id: m.id,
      label: m.label,
      ...catalogValues(m),
      source: "catalog",
      origin: "catalog",
      featured: m.featured,
    }),
  );
}

/** A served id the catalog never heard of: nothing describes it but its id. */
export function idOnlyRow(id: string): ModelPickRow {
  return pickRow({ id, origin: "catalog" });
}

export function discoveredRows(models: readonly DiscoveredModel[]): ModelPickRow[] {
  return models.map((m) =>
    pickRow({
      id: m.id,
      label: m.label,
      contextWindow: m.context_window,
      maxTokens: m.max_tokens,
      input: m.input,
      reasoning: m.reasoning,
      source: m.source,
      endpointCapabilities: {
        contextWindow: m.endpoint_capabilities.context_window,
        maxTokens: m.endpoint_capabilities.max_tokens,
        input: m.endpoint_capabilities.input,
        reasoning: m.endpoint_capabilities.reasoning,
      },
      origin: "discover",
    }),
  );
}

export function searchRows(models: readonly OpenRouterModel[]): ModelPickRow[] {
  return models.map((m) =>
    pickRow({
      id: m.id,
      label: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      input: m.input,
      reasoning: m.reasoning,
      source: "endpoint",
      cost: m.cost,
      origin: "search",
    }),
  );
}

/** Client-side search over a list. A remote search filters itself. */
export function filterRows(rows: readonly ModelPickRow[], search: string): ModelPickRow[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    (r) => r.id.toLowerCase().includes(needle) || !!r.label?.toLowerCase().includes(needle),
  );
}
