// SPDX-License-Identifier: Apache-2.0

/**
 * Lists spanning several spaces of the org (runs, schedules, files): the pieces they share.
 *
 * A row of another space than the current one links to its detail with `?enterSpace=`; the
 * detail enters that space, then drops the param (`useEnterLinkedSpace`). Not `?space=`: the
 * file reader's `?org=…&space=…` names where to read WITHOUT switching.
 */

export const ENTER_SPACE_PARAM = "enterSpace";

/** `path` as it was within the current space; naming the row's space otherwise. */
export function linkedSpacePath(
  path: string,
  spaceId: string,
  currentSpaceId: string | null,
): string {
  // No current space yet: nothing to move from.
  if (!currentSpaceId || spaceId === currentSpaceId) return path;
  return `${path}?${new URLSearchParams({ [ENTER_SPACE_PARAM]: spaceId }).toString()}`;
}

/**
 * What `useEnterLinkedSpace` does next. `enterable` is `undefined` while the space listing has
 * not answered; a listing that failed answers `false`, so the page renders its own state instead
 * of waiting for good. Exported for its test.
 */
export function linkedSpaceStep(
  linked: string | null,
  current: string | null,
  enterable: boolean | undefined,
): "none" | "wait" | "enter" | "drop" {
  if (!linked) return "none";
  if (enterable === undefined) return "wait";
  return enterable && current !== linked ? "enter" : "drop";
}

/**
 * The SSE stream is scoped to the current space: rows of the others are polled, and only while
 * one still moves. Same period as the stream's reconnect reconciliation.
 */
export const ACROSS_SPACES_POLL_MS = 10_000;

export function pollWhileMoving<T>(
  rows: readonly T[] | undefined,
  moving: (row: T) => boolean,
): number | false {
  return rows?.some(moving) ? ACROSS_SPACES_POLL_MS : false;
}
