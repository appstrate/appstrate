// SPDX-License-Identifier: Apache-2.0

import { and, eq } from "drizzle-orm";
import { getBillingDb } from "../db.ts";
import { computeUsage } from "../../drizzle/schema.ts";
import { periodStartOf } from "./period.ts";

/**
 * Seconds `orgId` has consumed in the calendar month `now` falls in. A month with no row yet
 * (the first run of the month, or an org that never ran) is zero: the monthly reset is the
 * absence of a row, not an operation.
 */
export async function readComputeSecondsUsed(
  orgId: string,
  now: Date = new Date(),
): Promise<number> {
  const [row] = await getBillingDb()
    .select({ secondsUsed: computeUsage.secondsUsed })
    .from(computeUsage)
    .where(and(eq(computeUsage.orgId, orgId), eq(computeUsage.periodStart, periodStartOf(now))));
  return row?.secondsUsed ?? 0;
}
