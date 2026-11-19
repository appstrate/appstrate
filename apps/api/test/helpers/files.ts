// SPDX-License-Identifier: Apache-2.0

import type { Actor } from "@appstrate/connect";
import { listFilesForActor, type ListFilesFilters } from "../../src/services/files.ts";

/** The one-space gallery, as `GET /api/files` calls it, reaching that space alone. */
export function listFilesIn(
  scope: { orgId: string; spaceId: string },
  actor: Actor,
  filters: ListFilesFilters,
  permissions: ReadonlySet<string>,
) {
  const grants = [{ spaceId: scope.spaceId, permissions }];
  return listFilesForActor(scope.orgId, grants, actor, filters, { fileAccess: { grants } });
}
