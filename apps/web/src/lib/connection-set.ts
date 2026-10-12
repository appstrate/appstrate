// SPDX-License-Identifier: Apache-2.0

import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import type { components } from "../api/schema";
import type { IntegrationConnection } from "../hooks/use-integrations";
import type { RunOverridesValue } from "./schedule-payload";
import { sameSet } from "./strings";

/** At the cap an addition is refused and `ids` comes back unchanged. */
export function toggleCapped(ids: string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  if (ids.length >= MAX_CONNECTIONS_PER_INTEGRATION) return ids;
  return [...ids, id];
}

/** A cascade layer's stored set: `null` defers to the next layer, `[]` wins and binds none. */
export type ConnectionSet = string[] | null;

/**
 * `overrides` with one integration's set replaced; `null` removes its key, and an emptied map
 * drops `connection_overrides`.
 */
export function withConnectionOverride(
  overrides: RunOverridesValue,
  integrationId: string,
  connectionIds: ConnectionSet,
): RunOverridesValue {
  const { connection_overrides: picks, ...rest } = overrides;
  const next = { ...picks };
  if (connectionIds !== null) next[integrationId] = connectionIds;
  else delete next[integrationId];
  return Object.keys(next).length > 0 ? { ...rest, connection_overrides: next } : rest;
}

/**
 * `overrides` with `connection_overrides` narrowed to the integrations the definition declares:
 * the server refuses any other key (400). `declared` unknown (not loaded) keeps every key.
 */
export function withDeclaredConnections(
  overrides: RunOverridesValue,
  declared: readonly string[] | undefined,
): RunOverridesValue {
  const { connection_overrides: picks, ...rest } = overrides;
  if (!picks || !declared) return overrides;
  const kept = Object.entries(picks).filter(([id]) => declared.includes(id));
  return kept.length > 0 ? { ...rest, connection_overrides: Object.fromEntries(kept) } : rest;
}

/** What {@link withFallbackConnections} reads of one integration's readiness entry. */
export interface FallbackBindingEntry {
  integration_package_id: string;
  inert: boolean;
  resolution: Pick<
    components["schemas"]["IntegrationAgentResolution"],
    "source" | "resolved_connection_ids"
  >;
}

/**
 * `overrides` naming, for each integration a run binds and no pick covers (`[]` is one), the set
 * the fallback binds in that actor's `readiness` (`fallback_auto`), whatever its health.
 */
export function withFallbackConnections(
  overrides: RunOverridesValue,
  readiness: readonly FallbackBindingEntry[] | undefined,
): RunOverridesValue {
  let next = overrides;
  for (const entry of readiness ?? []) {
    const id = entry.integration_package_id;
    const { source, resolved_connection_ids: bound } = entry.resolution;
    const binds = !entry.inert && source === "fallback_auto" && bound.length > 0;
    if (binds && next.connection_overrides?.[id] === undefined) {
      next = withConnectionOverride(next, id, bound);
    }
  }
  return next;
}

export function keepAvailable(ids: string[], availableIds: string[]): string[] {
  return ids.filter((id) => availableIds.includes(id));
}

/**
 * "Valider" writes a non-empty set that differs from the stored pick. Untouched, that is
 * only a stored pick naming an id no longer a candidate — never the cascade's fallback.
 */
export function canApplyConnectionSet(
  checked: readonly { id: string }[],
  explicitIds: ConnectionSet,
  touched: boolean,
): boolean {
  if (checked.length === 0) return false;
  if (!touched && explicitIds === null) return false;
  return !sameSet(
    checked.map((c) => c.id),
    explicitIds ?? [],
  );
}

/**
 * The set a picker holds, kept to the candidates: the uncommitted `draft`, else the stored pick,
 * else what the cascade binds. Without a draft it is the set displayed as bound; with one, the
 * ticked set "Valider" writes — a tick the user cannot see is one they cannot remove.
 */
export function checkedConnectionIds(input: {
  draft: string[] | null;
  explicitIds: ConnectionSet;
  resolvedIds: string[];
  candidateIds: string[];
}): string[] {
  const base = input.draft ?? input.explicitIds ?? input.resolvedIds;
  return keepAvailable(base, input.candidateIds);
}

/**
 * Stored members that are no candidate for this agent. The resolver refuses such a set rather
 * than bind what is left, so the picker names them and "Valider" visibly drops them.
 */
export function unavailableConnectionIds(explicitIds: string[], candidateIds: string[]): string[] {
  return explicitIds.filter((id) => !candidateIds.includes(id));
}

/**
 * The set a picker persists once a connection was created from it: `boundIds` (what the picker
 * binds, the cascade's fallback included) plus `createdId`. A connection created to replace a
 * member (`replacing`) takes its place 1-for-1. At the cap `boundIds` comes back unchanged.
 */
export function placeCreatedConnection(input: {
  boundIds: string[];
  createdId: string;
  replacing?: string;
}): string[] {
  const { boundIds, createdId, replacing } = input;
  if (replacing !== undefined && boundIds.includes(replacing)) {
    return boundIds.map((id) => (id === replacing ? createdId : id));
  }
  return boundIds.length >= MAX_CONNECTIONS_PER_INTEGRATION ? boundIds : [...boundIds, createdId];
}

/**
 * Option label for the two admin pickers (org default, pins). Those lists
 * are org-wide — since the connections endpoint returns shared connections
 * owned by other members, an admin choosing a cross-agent default is picking
 * between rows whose labels can collide ("Connexion 1" for two members), so
 * the owner is part of the identity here. The per-row table carries the same
 * information as a badge instead, where a suffix would fight the rename UI.
 */
export function connectionOptionLabel(c: IntegrationConnection): string {
  return c.owner_name ? `${c.label} — ${c.owner_name}` : c.label;
}
