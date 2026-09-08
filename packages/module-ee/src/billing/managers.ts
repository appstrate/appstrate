/**
 * Billing managers — the org users who hold `billing:read` + `billing:manage`
 * without being org admins (RBAC spec §10).
 *
 * The grant travels through the module contract's `principalPermissions`
 * surface, so it attaches to a `(orgId, userId)` pair rather than to an org
 * role. That is the whole point: `billing` is cloud vocabulary, core's
 * `org_role` enum is Apache-2.0, and a `billing_manager` role would put the
 * one inside the other.
 *
 * INVALIDATION IS OURS. The platform caches each principal's extra grants for
 * 10s and cannot know when this table changed, so every write here calls
 * `invalidatePrincipalPermissions` for each principal it touched — the users
 * ADDED and the users REMOVED, since a stale cache is equally wrong in both
 * directions (a removed manager keeps acting on billing; an added one is told
 * they cannot).
 */

import { and, eq, inArray } from "drizzle-orm";
import { invalidatePrincipalPermissions } from "@appstrate/core/principal-permissions";
import { getCloudDb } from "../db.ts";
import { billingManagers } from "../../drizzle/schema.ts";

/** The two strings a billing manager holds — also the module's `mayGrant`. */
export const BILLING_MANAGER_PERMISSIONS = ["billing:read", "billing:manage"] as const;

export interface BillingManager {
  userId: string;
  addedBy: string;
  createdAt: Date;
}

/** The org's managers, oldest grant first. */
export async function listBillingManagers(orgId: string): Promise<BillingManager[]> {
  const db = getCloudDb();
  return db
    .select({
      userId: billingManagers.userId,
      addedBy: billingManagers.addedBy,
      createdAt: billingManagers.createdAt,
    })
    .from(billingManagers)
    .where(eq(billingManagers.orgId, orgId))
    .orderBy(billingManagers.createdAt);
}

/**
 * The `principalPermissions` resolver's read: one primary-key lookup, called
 * once per principal per cache miss on every session request. Keep it that.
 */
export async function isBillingManager(orgId: string, userId: string): Promise<boolean> {
  const db = getCloudDb();
  const [row] = await db
    .select({ userId: billingManagers.userId })
    .from(billingManagers)
    .where(and(eq(billingManagers.orgId, orgId), eq(billingManagers.userId, userId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Replace the org's manager set with `userIds`, attributing the grant to
 * `addedBy`. Returns the resulting set.
 *
 * Replacement rather than add/remove verbs because the route is a `PUT` of the
 * whole list: the dashboard edits a list and saves it, and two callers saving
 * concurrently then resolve to one of the two lists instead of to a merge
 * neither of them chose.
 *
 * The delete and the insert share one transaction so the org is never briefly
 * without managers.
 */
export async function replaceBillingManagers(
  orgId: string,
  userIds: readonly string[],
  addedBy: string,
): Promise<BillingManager[]> {
  const db = getCloudDb();
  const wanted = [...new Set(userIds)];

  const previous = await db
    .select({ userId: billingManagers.userId })
    .from(billingManagers)
    .where(eq(billingManagers.orgId, orgId));
  const previousIds = previous.map((r) => r.userId);

  // Only the difference is written: rows that survive keep their original
  // `created_at` / `added_by`, so re-saving an unchanged list rewrites nothing.
  // Scoped to the ids this caller actually observed, so a row inserted
  // concurrently is not dropped by a set that never saw it.
  const toRemove = previousIds.filter((id) => !wanted.includes(id));
  await db.transaction(async (tx) => {
    if (toRemove.length > 0) {
      await tx
        .delete(billingManagers)
        .where(and(eq(billingManagers.orgId, orgId), inArray(billingManagers.userId, toRemove)));
    }
    if (wanted.length > 0) {
      await tx
        .insert(billingManagers)
        .values(wanted.map((userId) => ({ orgId, userId, addedBy })))
        .onConflictDoNothing();
    }
  });

  for (const userId of new Set([...toRemove, ...wanted])) {
    invalidatePrincipalPermissions(orgId, userId);
  }

  return listBillingManagers(orgId);
}

/**
 * Drop every manager of a deleted org. Called from `onOrgDelete`: the rows
 * carry no FK to the platform's `organizations` table, so nothing else removes
 * them, and a manager row outliving its org would answer for an org id the
 * platform could later reuse.
 */
export async function deleteBillingManagers(orgId: string): Promise<void> {
  const db = getCloudDb();
  const removed = await db
    .delete(billingManagers)
    .where(eq(billingManagers.orgId, orgId))
    .returning({ userId: billingManagers.userId });
  for (const row of removed) {
    invalidatePrincipalPermissions(orgId, row.userId);
  }
}
