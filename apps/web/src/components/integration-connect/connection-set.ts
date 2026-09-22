// SPDX-License-Identifier: Apache-2.0

/** Stable reference: a fresh `[]` would re-fork a controlled child's state each render. */
export const EMPTY_CONNECTION_SET: string[] = [];

/** Returns `ids` by identity when the cap blocks the addition, so callers can spot the no-op. */
export function toggleCapped(ids: string[], id: string, max: number): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  if (ids.length >= max) return ids;
  return [...ids, id];
}

/**
 * The set a picker displays as bound. A member pin with no pick still shows what the
 * cascade resolves; an override with no pick is *inherit* and must show nothing.
 */
export function displayedConnectionIds(input: {
  overrideMode: boolean;
  explicitIds: string[];
  resolvedIds: string[];
}): string[] {
  if (input.explicitIds.length > 0) return input.explicitIds;
  return input.overrideMode ? EMPTY_CONNECTION_SET : input.resolvedIds;
}
