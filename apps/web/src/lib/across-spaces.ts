// SPDX-License-Identifier: Apache-2.0

/**
 * Lists spanning several spaces. A row of another space links to its detail with `?enterSpace=`
 * (not `?space=`, the file reader's read-without-switching), which the resolver enters and the
 * route's gate then drops with `replace`, so Back returns to the list.
 */

import { ENTER_SPACE_PARAM } from "@appstrate/core/chat-contract";
import { isSpaceEnterable } from "./space-lists";

/**
 * The space a row listed in several spaces (a package index) opens in: the current one when it is
 * among them, else the first.
 */
export function rowSpace(
  spaceIds: readonly string[] | undefined,
  currentSpaceId: string | null,
): string | undefined {
  if (currentSpaceId && spaceIds?.includes(currentSpaceId)) return currentSpaceId;
  return spaceIds?.[0];
}

/**
 * `path` as it was within the current space (or for a row of no space); naming the row's space
 * otherwise, merged into the query `path` already carries, its hash kept last.
 */
export function linkedSpacePath(
  path: string,
  spaceId: string | undefined,
  currentSpaceId: string | null,
): string {
  // No current space yet: nothing to move from.
  if (!spaceId || !currentSpaceId || spaceId === currentSpaceId) return path;
  const hashAt = path.indexOf("#");
  const hash = hashAt < 0 ? "" : path.slice(hashAt);
  const beforeHash = hashAt < 0 ? path : path.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const pathname = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const params = new URLSearchParams(queryAt < 0 ? "" : beforeHash.slice(queryAt + 1));
  params.set(ENTER_SPACE_PARAM, spaceId);
  return `${pathname}?${params.toString()}${hash}`;
}

/**
 * Whether the space a link names can be entered: `undefined` until the listing answers; a failed
 * listing cannot prove it, so `false`.
 */
export function linkedSpaceEnterable(
  spaces: readonly { id: string; access: string }[] | undefined,
  listingFailed: boolean,
  linked: string | null,
): boolean | undefined {
  if (spaces) return spaces.some((space) => space.id === linked && isSpaceEnterable(space));
  return listingFailed ? false : undefined;
}

/**
 * What `useEnterLinkedSpace` does next: wait while the resolver enters the linked space, drop the
 * param once it has. `enterable` is `undefined` while the space listing has not answered; a
 * listing that failed answers `false`, so the page renders its own state instead of waiting for
 * good.
 */
export function linkedSpaceStep(
  linked: string | null,
  current: string | null,
  enterable: boolean | undefined,
): "none" | "wait" | "drop" {
  if (!linked) return "none";
  if (enterable === undefined) return "wait";
  return enterable && current !== linked ? "wait" : "drop";
}

/**
 * Where the page reopens: `target` in the first enterable space of `spaceIds` after the one that
 * refused, so repeated refusals cannot loop; `null` when none is left.
 */
export function detailElsewhere(
  spaceIds: readonly string[],
  target: string,
  currentSpaceId: string | null,
  enterable: (spaceId: string) => boolean,
): string | null {
  if (!currentSpaceId) return null;
  const next = spaceIds.slice(spaceIds.indexOf(currentSpaceId) + 1).find(enterable);
  return next ? linkedSpacePath(target, next, currentSpaceId) : null;
}

/**
 * The SSE stream is scoped to the current space: a run, schedule, file or agent list spanning
 * spaces polls while mounted, or it would never see a new row (or an agent's run counts) of another
 * space. React Query pauses it in a hidden tab.
 */
export const ACROSS_SPACES_POLL_MS = 10_000;
