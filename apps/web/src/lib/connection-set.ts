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

/** `picks` (integration id → set) with one integration's set replaced; `null` removes the key. */
export function withConnectionPick(
  picks: Readonly<Record<string, string[]>>,
  integrationId: string,
  connectionIds: ConnectionSet,
): Record<string, string[]> {
  const next = { ...picks };
  if (connectionIds !== null) next[integrationId] = connectionIds;
  else delete next[integrationId];
  return next;
}

/** {@link withConnectionPick} on `overrides.connection_overrides`; an empty map drops the key. */
export function withConnectionOverride(
  overrides: RunOverridesValue,
  integrationId: string,
  connectionIds: ConnectionSet,
): RunOverridesValue {
  const { connection_overrides: picks, ...rest } = overrides;
  const next = withConnectionPick(picks ?? {}, integrationId, connectionIds);
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

/** Bound as displayed: an unpinned member still sees the cascade; an unpicked override inherits. */
export function displayedConnectionIds(input: {
  overrideMode: boolean;
  explicitIds: ConnectionSet;
  resolvedIds: string[];
}): string[] {
  if (input.explicitIds !== null) return input.explicitIds;
  return input.overrideMode ? [] : input.resolvedIds;
}

/** The ticked set "Valider" writes. A tick the user cannot see is one they cannot remove. */
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
 * Where a connection created from the picker goes. With no pick of the actor's own (or a pick of
 * none) it becomes the pick — never joined onto the cascade's fallback, which would freeze an org
 * default into a member pin. Beside an explicit pick it is only ticked: binding several
 * connections is always the actor's explicit "Valider".
 */
export function placeCreatedConnection(input: {
  explicitIds: ConnectionSet;
  checkedIds: string[];
  createdId: string;
}): { persist: string[] } | { draft: string[] } {
  if (!input.explicitIds?.length) return { persist: [input.createdId] };
  const { checkedIds, createdId } = input;
  return {
    draft:
      checkedIds.includes(createdId) || checkedIds.length >= MAX_CONNECTIONS_PER_INTEGRATION
        ? checkedIds
        : [...checkedIds, createdId],
  };
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
