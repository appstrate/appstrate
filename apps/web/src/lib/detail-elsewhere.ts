// SPDX-License-Identifier: Apache-2.0

/**
 * A detail page opened in « Tous les espaces » on a resource the hidden working space cannot read:
 * a read spanning spaces says where it is, and the page reopens there.
 */

import { ApiError } from "../api/client";
import { linkedSpacePath } from "./across-spaces";

/** Whether a detail read failed for want of the resource here (403, 404, or a 404 read as `null`). */
export function isUnreadableHere(error: unknown): boolean {
  return !error || (error instanceof ApiError && (error.status === 403 || error.status === 404));
}

/** A resource the read spanning spaces found, with the spaces it sits in, in the order tried. */
export interface ElsewhereRow {
  id: string;
  spaceIds: readonly string[];
}

/**
 * The space to try next among a row's: the first enterable one listed AFTER the working space,
 * or the first enterable one when the working space is not listed. Never one before it: each
 * refusal moves forward, so a chain of refusals ends instead of bouncing between two spaces.
 */
export function nextSpaceToTry(
  spaceIds: readonly string[],
  currentSpaceId: string,
  enterable: (spaceId: string) => boolean,
): string | undefined {
  const at = spaceIds.indexOf(currentSpaceId);
  return spaceIds.slice(at + 1).find(enterable);
}

/**
 * Where the detail of `id` opens instead: `target` (path, search and hash) in {@link nextSpaceToTry},
 * with `?enterSpace=`. `undefined` while the read has not answered; `null` when no row names it,
 * no space is left to try, or no space is resolved yet (nothing to move from).
 */
export function detailElsewhere(
  rows: readonly ElsewhereRow[] | undefined,
  id: string,
  target: string,
  currentSpaceId: string | null,
  enterable: (spaceId: string) => boolean,
): string | null | undefined {
  if (rows === undefined) return undefined;
  if (!currentSpaceId) return null;
  const spaceIds = rows.find((row) => row.id === id)?.spaceIds ?? [];
  const spaceId = nextSpaceToTry(spaceIds, currentSpaceId, enterable);
  return spaceId ? linkedSpacePath(target, spaceId, currentSpaceId) : null;
}
