// SPDX-License-Identifier: Apache-2.0

/**
 * A detail page opened in « Tous les espaces » on a resource the hidden working space cannot read:
 * the list spanning spaces says where it is, and the page reopens there.
 */

import { ApiError } from "../api/client";
import { linkedSpacePath, rowSpace } from "./across-spaces";

/** Whether a detail read failed for want of the resource here (403, 404, or a 404 read as `null`). */
export function isUnreadableHere(error: unknown): boolean {
  return !error || (error instanceof ApiError && (error.status === 403 || error.status === 404));
}

/**
 * Where the detail of `id` opens instead: `path` in the space of the spanning list's row naming
 * it (`rowSpace`), with `?enterSpace=`. `undefined` while the list has not answered; `null` when
 * no row names it, or only the working space does (reopening there would read the same refusal).
 */
export function detailElsewhere(
  rows: readonly { id: string; spaceIds: readonly string[] }[] | undefined,
  id: string,
  path: string,
  currentSpaceId: string | null,
): string | null | undefined {
  if (rows === undefined) return undefined;
  const spaceId = rowSpace(rows.find((row) => row.id === id)?.spaceIds, currentSpaceId);
  if (!spaceId || spaceId === currentSpaceId) return null;
  return linkedSpacePath(path, spaceId, currentSpaceId);
}
