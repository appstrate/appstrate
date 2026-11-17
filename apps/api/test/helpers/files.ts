// SPDX-License-Identifier: Apache-2.0

import type { Actor } from "@appstrate/connect";
import { listFilesForActor, type ListFilesFilters } from "../../src/services/files.ts";

/** The one-space gallery, as `GET /api/files` calls it. */
export function listFilesIn(
  scope: { orgId: string; spaceId: string },
  actor: Actor,
  filters: ListFilesFilters,
  permissions: ReadonlySet<string>,
) {
  return listFilesForActor(scope.orgId, [{ spaceId: scope.spaceId, permissions }], actor, filters);
}
