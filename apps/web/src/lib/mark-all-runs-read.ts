// SPDX-License-Identifier: Apache-2.0

import { spaceHeader } from "./scoping-headers";

/**
 * The `PUT /api/runs/read-all` requests behind « Tout marquer comme lu »: the route marks the
 * runs of one space, so a list spanning spaces sends one per space it spans, each naming its
 * space; `null` is the working space's list, one request the client's middleware scopes.
 */
export function markAllRunsReadRequests(
  spaceIds: readonly string[] | null,
): ReturnType<typeof spaceHeader>[] {
  if (spaceIds === null) return [{}];
  return spaceIds.map((spaceId) => spaceHeader(spaceId));
}
