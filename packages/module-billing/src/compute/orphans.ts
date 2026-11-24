// SPDX-License-Identifier: Apache-2.0

/**
 * Removal of the compute rows of organizations that no longer exist.
 *
 * `onOrgDelete` deletes an org's counters and claims BEFORE the platform's cascade removes its
 * runs. A settlement pass that lands in that gap reads the org's runs again, claims them again
 * (their claims are gone) and recreates counter rows for an org that is about to vanish. The
 * rows are harmless (nothing reads an absent org), but nothing else would ever delete them,
 * and no foreign key can: this module declares none across its boundary.
 *
 * So the sweep asks the platform which of the orgs it holds counters for still exist
 * (`getOrgName` answers `null` for an absent one) and drops the rest. Bounded per call, and
 * run hourly: it is housekeeping, never on the settlement path.
 */

import { eq } from "drizzle-orm";
import { getBillingDb } from "../db.ts";
import { computeUsage, settledRuns } from "../../drizzle/schema.ts";
import { getOrgQueries } from "../platform-org-queries.ts";
import { logger } from "../logger.ts";

/** Most orgs checked per call: one platform lookup each. */
const PURGE_BATCH = 500;

/** Returns how many organizations' rows were removed. */
export async function purgeOrphanedOrgs(): Promise<number> {
  const db = getBillingDb();
  const candidates = await db
    .selectDistinct({ orgId: computeUsage.orgId })
    .from(computeUsage)
    .limit(PURGE_BATCH);

  let purged = 0;
  for (const { orgId } of candidates) {
    if ((await getOrgQueries().getOrgName(orgId)) !== null) continue;
    await db.delete(computeUsage).where(eq(computeUsage.orgId, orgId));
    await db.delete(settledRuns).where(eq(settledRuns.orgId, orgId));
    purged++;
  }
  if (purged > 0) logger.info("purged compute rows of deleted organizations", { purged });
  return purged;
}
