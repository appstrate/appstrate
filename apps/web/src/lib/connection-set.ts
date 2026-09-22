// SPDX-License-Identifier: Apache-2.0

import { labelsSharedBy } from "@appstrate/core/integration";

/** At the cap an addition is refused and `ids` comes back unchanged. */
export function toggleCapped(ids: string[], id: string, max: number): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  if (ids.length >= max) return ids;
  return [...ids, id];
}

export function keepAvailable(ids: string[], availableIds: string[]): string[] {
  return ids.filter((id) => availableIds.includes(id));
}

/** Each label the set carries more than once — the resolver refuses to bind such a set. */
export function sharedLabels(rows: readonly { label: string }[]): string[] {
  return [...new Set(labelsSharedBy(rows).map((r) => r.label))];
}

function sameConnectionSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** "Valider" writes only a non-empty, addressable set that differs from the stored pick. */
export function canApplyConnectionSet(
  checked: readonly { id: string; label: string }[],
  explicitIds: string[],
): boolean {
  if (checked.length === 0 || sharedLabels(checked).length > 0) return false;
  return !sameConnectionSet(
    checked.map((c) => c.id),
    explicitIds,
  );
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
