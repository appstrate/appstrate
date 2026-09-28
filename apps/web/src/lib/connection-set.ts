// SPDX-License-Identifier: Apache-2.0

/** At the cap an addition is refused and `ids` comes back unchanged. */
export function toggleCapped(ids: string[], id: string, max: number): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  if (ids.length >= max) return ids;
  return [...ids, id];
}

/**
 * `picks` (integration id → set) with one integration's set replaced; an empty
 * set removes the key, since an empty set is refused on the wire.
 */
export function withConnectionPick(
  picks: Readonly<Record<string, string[]>>,
  integrationId: string,
  connectionIds: string[],
): Record<string, string[]> {
  const next = { ...picks };
  if (connectionIds.length > 0) next[integrationId] = connectionIds;
  else delete next[integrationId];
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
  explicitIds: string[],
  touched: boolean,
): boolean {
  if (checked.length === 0) return false;
  if (!touched && explicitIds.length === 0) return false;
  const ids = checked.map((c) => c.id);
  return !(ids.length === explicitIds.length && ids.every((id) => explicitIds.includes(id)));
}

/** Bound as displayed: an unpinned member still sees the cascade; an unpicked override inherits. */
export function displayedConnectionIds(input: {
  overrideMode: boolean;
  explicitIds: string[];
  resolvedIds: string[];
}): string[] {
  if (input.explicitIds.length > 0) return input.explicitIds;
  return input.overrideMode ? [] : input.resolvedIds;
}

/** The ticked set "Valider" writes. A tick the user cannot see is one they cannot remove. */
export function checkedConnectionIds(input: {
  draft: string[] | null;
  explicitIds: string[];
  resolvedIds: string[];
  candidateIds: string[];
}): string[] {
  const base =
    input.draft ?? (input.explicitIds.length > 0 ? input.explicitIds : input.resolvedIds);
  return keepAvailable(base, input.candidateIds);
}

/**
 * Stored members that are no candidate for this agent (deleted, unshared, or on an auth
 * serving no selected tool). They stay in the stored set — the resolver refuses it
 * rather than bind what is left — so the picker names them, and "Valider" visibly
 * drops them.
 */
export function unavailableConnectionIds(explicitIds: string[], candidateIds: string[]): string[] {
  return explicitIds.filter((id) => !candidateIds.includes(id));
}

/**
 * A new connection joins what the actor chose, never the cascade's fallback — that
 * would freeze an org default into a member pin. `null` = nothing to write.
 */
export function joinCreatedConnection(input: {
  explicitIds: string[];
  candidateIds: string[];
  createdId: string;
  max: number;
}): string[] | null {
  const kept = keepAvailable(input.explicitIds, input.candidateIds);
  if (kept.includes(input.createdId) || kept.length >= input.max) return null;
  return [...kept, input.createdId];
}
