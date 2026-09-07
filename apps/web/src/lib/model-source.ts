// SPDX-License-Identifier: Apache-2.0

/**
 * Where the model form's pick list comes from, and the one row shape all three
 * sources produce.
 *
 * The form asks the same question for every provider — "which of these models
 * do you want?" — and only the listing behind it changes. `origin` travels on
 * the row so the batch payload knows how much of it to put on the wire.
 */

import type { ModelCost } from "@appstrate/core/module";
import type { DiscoveredModel } from "../hooks/use-model-provider-credentials";
import type { OpenRouterModel } from "../hooks/use-models";

export type ModelSource = "catalog" | "discover" | "search";

/** The registry facts the rule turns on — a `ProviderRegistryEntry` fits. */
export interface ModelSourceProvider {
  providerId: string;
  authMode: "api_key" | "oauth2";
  models: readonly unknown[];
}

/**
 * Which listing answers for this provider.
 *
 * `search` names the one provider id the client compares by name, and the
 * reason is billing rather than layout: `GET /api/models/openrouter` is a live
 * server-side search that returns per-token cost, which `POST /discover` never
 * returns by design (a third-party endpoint is not billed at the vendor's
 * rate). OpenRouter is the single provider whose listing IS the billing rate,
 * so it cannot be folded into either of the other two.
 *
 * `catalog` covers every entry the vendored pricing catalog describes — pinned
 * api-key providers — and every oauth2 one whatever it ships: a subscription's
 * listing is what the plan serves, read against the catalog (id-only rows for
 * the rest), and `POST /discover` refuses to spend a subscription token anyway.
 * `discover` is the rest: the base-URL-overridable entries, and any future
 * api-key provider shipping no catalog, which today would dead-end.
 */
export function modelSource(provider: ModelSourceProvider | undefined): ModelSource | null {
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
  /** Who described the row, where anything did — rendered as a badge. */
  source: "endpoint" | "catalog" | null;
  cost: ModelCost | null;
  /** The listing it came from: what the batch is allowed to send. */
  origin: ModelSource;
  /** Catalog-only: the curated group the row belongs to. */
  featured: boolean;
}

/** The catalog fields a registry entry publishes per model. */
export interface CatalogModelEntry {
  id: string;
  label: string;
  contextWindow: number;
  maxTokens?: number | null;
  capabilities: string[];
  featured: boolean;
}

/** The two capability strings that describe an input modality, not a behaviour. */
const MODALITIES = ["text", "image"];

export function catalogModalities(capabilities: readonly string[]): string[] {
  return capabilities.filter((c) => MODALITIES.includes(c));
}

export function catalogRows(entries: readonly CatalogModelEntry[]): ModelPickRow[] {
  return entries.map((m) => ({
    id: m.id,
    label: m.label,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens ?? null,
    input: catalogModalities(m.capabilities),
    reasoning: m.capabilities.includes("reasoning"),
    source: "catalog",
    cost: null,
    origin: "catalog",
    featured: m.featured,
  }));
}

/**
 * A model a subscription serves that the catalog has never heard of. Nothing
 * describes it but its id, and it stays offered rather than vanishing.
 */
export function idOnlyRow(id: string): ModelPickRow {
  return {
    id,
    label: null,
    contextWindow: null,
    maxTokens: null,
    input: null,
    reasoning: null,
    source: null,
    cost: null,
    origin: "catalog",
    featured: false,
  };
}

export function discoveredRows(models: readonly DiscoveredModel[]): ModelPickRow[] {
  return models.map((m) => ({
    id: m.id,
    label: m.label,
    contextWindow: m.context_window,
    maxTokens: m.max_tokens,
    input: m.input,
    reasoning: m.reasoning,
    source: m.source,
    cost: null,
    origin: "discover",
    featured: false,
  }));
}

export function searchRows(models: readonly OpenRouterModel[]): ModelPickRow[] {
  return models.map((m) => ({
    id: m.id,
    label: m.name,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    input: m.input,
    reasoning: m.reasoning,
    source: "endpoint",
    cost: m.cost,
    origin: "search",
    featured: false,
  }));
}

/** The list's search box, applied client-side. A remote search filters itself. */
export function filterRows(rows: readonly ModelPickRow[], search: string): ModelPickRow[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    (r) => r.id.toLowerCase().includes(needle) || !!r.label?.toLowerCase().includes(needle),
  );
}
