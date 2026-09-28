// SPDX-License-Identifier: Apache-2.0

/**
 * Row locks on `integration_connections`, in a module of their own so every writer can take them
 * without importing the connection service (which `spaces.ts` → `space-members.ts` sits under).
 */

import { asc, inArray } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import type { Tx } from "../lib/db-helpers.ts";

/**
 * Row-lock `ids` in the caller's transaction, in id order so two lockers cannot deadlock:
 * `update` before a write that unshares or deletes them, `share` before an admin pin or org
 * default names them as shared. The two serialize, so neither can commit a state the other
 * checked against — a set naming a row that is concurrently unshared or deleted.
 */
export async function lockConnectionRows(
  tx: Tx,
  ids: readonly string[],
  strength: "update" | "share",
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(inArray(integrationConnections.id, [...ids]))
    .orderBy(asc(integrationConnections.id))
    .for(strength);
}
