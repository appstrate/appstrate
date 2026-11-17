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

/** Try only placements after the one that refused, so repeated refusals cannot loop. */
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
