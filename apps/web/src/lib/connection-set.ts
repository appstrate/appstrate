// SPDX-License-Identifier: Apache-2.0

import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
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

/** `null` removes the key; an emptied map drops `connection_overrides`. */
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

/** Narrowed to declared integrations: the server 400s on any other key. `declared` unloaded keeps every key. */
export function withDeclaredConnections(
  overrides: RunOverridesValue,
  declared: readonly string[] | undefined,
): RunOverridesValue {
  const { connection_overrides: picks, ...rest } = overrides;
  if (!picks || !declared) return overrides;
  const kept = Object.entries(picks).filter(([id]) => declared.includes(id));
  return kept.length > 0 ? { ...rest, connection_overrides: Object.fromEntries(kept) } : rest;
}

export function keepAvailable(ids: string[], availableIds: string[]): string[] {
  return ids.filter((id) => availableIds.includes(id));
}

/** "Valider" writes a non-empty set differing from the stored pick; never the set an unset pick shows. */
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
 * Explicit pick, else the member's pin, then a soft space default, else what the fallback binds.
 * `[]`: a layer chose no connection. `null`: no layer chose and nothing binds.
 */
export function shownConnectionPick(input: {
  explicitIds: ConnectionSet;
  memberPinIds: ConnectionSet;
  softDefaultIds: string[];
  resolvedIds: string[];
}): ConnectionSet {
  const chosen = input.explicitIds ?? input.memberPinIds;
  if (chosen !== null) return chosen;
  const bound = input.softDefaultIds.length > 0 ? input.softDefaultIds : input.resolvedIds;
  return bound.length > 0 ? bound : null;
}

/** What is CHOSEN, never what the cascade would bind ("Hériter" is the ticked row while nothing is chosen). */
export function checkedConnectionIds(input: {
  draft: string[] | null;
  explicitIds: ConnectionSet;
  candidateIds: string[];
}): string[] {
  const base = input.draft ?? input.explicitIds ?? [];
  return keepAvailable(base, input.candidateIds);
}

/** The resolver refuses such a set rather than bind what is left, so the picker names them. */
export function unavailableConnectionIds(storedIds: string[], candidateIds: string[]): string[] {
  return storedIds.filter((id) => !candidateIds.includes(id));
}

/** `boundIds` plus `createdId`; `replacing` is swapped 1-for-1. At the cap `boundIds` comes back unchanged. */
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

/** Admin pickers list org-wide shared connections whose labels can collide across members, so the owner is part of the identity. */
export function connectionOptionLabel(c: IntegrationConnection): string {
  return c.owner_name ? `${c.label} — ${c.owner_name}` : c.label;
}
