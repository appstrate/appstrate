// SPDX-License-Identifier: Apache-2.0

/**
 * Shared set semantics for every surface that composes the connections an
 * integration binds — the member/schedule picker, the admin org default, the
 * admin per-agent pin and the 412 recovery modal. All four write the WHOLE
 * set and all four cap it identically, so the toggle lives once.
 *
 * The collision rule is NOT here: it is `labelsSharedBy` in
 * `@appstrate/core/integration`, shared with the resolver that raises the 412.
 */

/**
 * Stable empty set. A `[]` literal passed as a controlled prop would be a new
 * reference on every render, re-forking the child's state each time.
 */
export const EMPTY_CONNECTION_SET: string[] = [];

/**
 * Add or remove `id`, refusing to grow past `max`. Returns the input array by
 * identity when the cap blocks the addition, so a caller can tell a no-op
 * from a change.
 */
export function toggleCapped(ids: string[], id: string, max: number): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  if (ids.length >= max) return ids;
  return [...ids, id];
}

/**
 * The set a picker DISPLAYS as bound, before the user touches anything.
 *
 * The two modes differ on what "no explicit pick" means, and conflating them
 * was a real bug: a member pin is the actor's standing choice, so with none
 * the agent page still shows what the cascade resolves (the value a run would
 * use). A schedule/run override with none means *inherit* — showing the
 * cascade's answer there would read as a pick the schedule does not hold, and
 * would offer a "reset to inherit" entry for a state already inherited.
 */
export function displayedConnectionIds(input: {
  overrideMode: boolean;
  explicitIds: string[];
  resolvedIds: string[];
}): string[] {
  if (input.explicitIds.length > 0) return input.explicitIds;
  return input.overrideMode ? EMPTY_CONNECTION_SET : input.resolvedIds;
}
