// SPDX-License-Identifier: Apache-2.0

/**
 * Pure logic behind the model form's pricing section — parsing the four typed
 * per-1M rates, folding them into the `ModelCost` the API accepts, and the
 * reverse projection used to display a catalog value.
 *
 * Split out of `model-form-modal.tsx` so it is unit-testable: the web test
 * runner has no DOM, and the modal imports the whole component tree.
 *
 * The one rule everything here exists to enforce: an EMPTY rate is not `0`.
 * "No rate for this bucket" is unknown pricing (the ledger flags such a run as
 * partially priced); `0` is a positive claim that the vendor bills nothing.
 * Coercing the first into the second is exactly how a run ends up reporting a
 * confident $0.
 */

import type { ModelCost } from "@appstrate/core/module";

/** The four per-1M rates as typed in the form (raw strings, possibly empty). */
export interface CostFields {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

/** RHF field name backing each rate — the pricing section's only mapping. */
export type CostFieldName = "costInput" | "costOutput" | "costCacheRead" | "costCacheWrite";

export const COST_FIELD_NAMES: Record<keyof CostFields, CostFieldName> = {
  input: "costInput",
  output: "costOutput",
  cacheRead: "costCacheRead",
  cacheWrite: "costCacheWrite",
};

/**
 * Parse one rate as typed. Tri-state on purpose: `{ ok: true }` with no value
 * is an empty field ("no rate"), which a `Number(x) || 0` would silently turn
 * into a free bucket.
 */
export function parseRate(raw: string): { ok: true; value?: number } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/**
 * Fold the typed rates into the `ModelCost` the API accepts, or `null` when the
 * model carries no usable pricing. `input`/`output` are required by the API's
 * `modelCostSchema`, so a partial or unparseable fill yields `null` (the form
 * refuses it in validation) rather than a zero-padded lie; the two cache rates
 * are simply omitted when empty.
 */
export function costFromFields(fields: CostFields): ModelCost | null {
  const input = parseRate(fields.input);
  const output = parseRate(fields.output);
  if (!input.ok || !output.ok) return null;
  if (input.value === undefined || output.value === undefined) return null;
  const cacheRead = parseRate(fields.cacheRead);
  const cacheWrite = parseRate(fields.cacheWrite);
  return {
    input: input.value,
    output: output.value,
    ...(cacheRead.ok && cacheRead.value !== undefined ? { cacheRead: cacheRead.value } : {}),
    ...(cacheWrite.ok && cacheWrite.value !== undefined ? { cacheWrite: cacheWrite.value } : {}),
  };
}

/** Loose cost shape as it arrives from the catalog registry / the models API. */
export interface WireCost {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
}

/**
 * Catalog / API cost → `ModelCost`, or `null` when there is no pricing to show.
 * Every field is optional on the wire, and the vendored catalog only carries
 * `cacheRead`/`cacheWrite` when LiteLLM upstream did — coverage is partial and
 * drifts weekly (see `scripts/refresh-pricing-catalog.ts`), so an absent rate
 * stays absent here instead of collapsing to 0.
 */
export function normalizeCost(cost: WireCost | null | undefined): ModelCost | null {
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") return null;
  return {
    input: cost.input,
    output: cost.output,
    ...(typeof cost.cacheRead === "number" ? { cacheRead: cost.cacheRead } : {}),
    ...(typeof cost.cacheWrite === "number" ? { cacheWrite: cost.cacheWrite } : {}),
  };
}

/** `ModelCost` → the four form strings. A missing rate renders as an empty field. */
export function costToFields(cost: ModelCost | null): CostFields {
  const str = (n: number | undefined) => (typeof n === "number" ? String(n) : "");
  return {
    input: str(cost?.input),
    output: str(cost?.output),
    cacheRead: str(cost?.cacheRead),
    cacheWrite: str(cost?.cacheWrite),
  };
}
