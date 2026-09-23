// SPDX-License-Identifier: Apache-2.0

import { asc, inArray } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import type { ResolvedConnectionMap } from "@appstrate/core/integration";
import { db } from "./db.ts";

/**
 * The `runs.resolved_connections` snapshot a run would carry if the cascade
 * bound EVERY stored connection of `integrationIds` — what spawn-resolver tests
 * pass when the subject is delivery, not which connection the cascade picks.
 */
export async function bindAllConnections(
  ...integrationIds: string[]
): Promise<ResolvedConnectionMap> {
  const rows = await db
    .select({
      id: integrationConnections.id,
      integrationId: integrationConnections.integrationId,
      label: integrationConnections.label,
      accountId: integrationConnections.accountId,
    })
    .from(integrationConnections)
    .where(inArray(integrationConnections.integrationId, integrationIds))
    .orderBy(asc(integrationConnections.createdAt), asc(integrationConnections.id));
  const snapshot: ResolvedConnectionMap = {};
  for (const row of rows) {
    (snapshot[row.integrationId] ??= []).push({
      connectionId: row.id,
      source: "fallback_auto",
      label: row.label,
      accountId: row.accountId,
    });
  }
  return snapshot;
}
