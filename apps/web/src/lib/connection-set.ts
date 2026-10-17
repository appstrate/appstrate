// SPDX-License-Identifier: Apache-2.0

import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import type { IntegrationConnection } from "../hooks/use-integrations";
import type { RunOverridesValue } from "./schedule-payload";
import { sameSet } from "./strings";

/** At the cap (`max`, what an imposed set leaves) an addition is refused and `ids` comes back unchanged. */
export function toggleCapped(
  ids: string[],
  id: string,
  max: number = MAX_CONNECTIONS_PER_INTEGRATION,
): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  if (ids.length >= max) return ids;
  return [...ids, id];
}

/** What binds under an imposed set: all of it, in its order, then the additions it lacks. */
export function imposedThenAdded(imposedIds: string[], addedIds: string[]): string[] {
  return [...imposedIds, ...addedIds.filter((id) => !imposedIds.includes(id))];
}

/**
 * A cascade layer's stored set: `null` defers to the next layer, `[]` wins and binds none. Under an
 * imposed set (an admin pin or an enforced default) a launch override or a member pin only adds
 * to it, so there `[]` means no addition and the imposed set still binds.
 */
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

/**
 * What « Enregistrer » writes for the ticked set, `undefined` when it writes nothing. `ticked` and
 * `stored` hold what is CHOSEN (under an imposed set, the additions alone); `initial` is what the
 * list opened with. Nothing is written while the ticks still show an unset choice untouched (that
 * would pin what the cascade already gives), nor when it equals the stored choice. An empty tick is
 * `emptyValue`: « no addition » under an imposed set, `undefined` elsewhere (« Aucune connexion »
 * is its own action).
 */
export function connectionSetToSave(input: {
  ticked: readonly string[];
  initial: readonly string[];
  stored: ConnectionSet;
  emptyValue: ConnectionSet | undefined;
}): ConnectionSet | undefined {
  const { ticked, initial, stored, emptyValue } = input;
  if (stored === null && sameSet(ticked, initial)) return undefined;
  const value = ticked.length > 0 ? [...ticked] : emptyValue;
  if (value === undefined) return undefined;
  const unchanged = value === null ? stored === null : stored !== null && sameSet(value, stored);
  return unchanged ? undefined : value;
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

/** The resolver refuses such a set rather than bind what is left, so the picker names them. */
export function unavailableConnectionIds(storedIds: string[], candidateIds: string[]): string[] {
  return storedIds.filter((id) => !candidateIds.includes(id));
}

/**
 * `boundIds` plus `createdId`; `replacing` is swapped 1-for-1. At the cap (`max`, what an
 * imposed set leaves) `boundIds` comes back unchanged.
 */
export function placeCreatedConnection(input: {
  boundIds: string[];
  createdId: string;
  replacing?: string;
  max?: number;
}): string[] {
  const { boundIds, createdId, replacing, max = MAX_CONNECTIONS_PER_INTEGRATION } = input;
  if (replacing !== undefined && boundIds.includes(replacing)) {
    return boundIds.map((id) => (id === replacing ? createdId : id));
  }
  return boundIds.length >= max ? boundIds : [...boundIds, createdId];
}

/** Admin pickers list org-wide shared connections whose labels can collide across members, so the owner is part of the identity. */
export function connectionOptionLabel(c: IntegrationConnection): string {
  return c.owner_name ? `${c.label} — ${c.owner_name}` : c.label;
}
