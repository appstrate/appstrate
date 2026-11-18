// SPDX-License-Identifier: Apache-2.0

/**
 * The 80 % compute-minutes warning: one email, to the billing recipients, the moment a
 * settlement pass carries an org's month across the threshold.
 *
 * "Once per crossing" needs no stored flag: the claims in `ee_settled_runs` make each
 * increment happen exactly once, so `previous < 80 % <= current` is true for exactly one
 * increment per month. An org that is already past the threshold when it arrives here is not
 * warned again, and a later month starts a fresh crossing.
 */

import { eq } from "drizzle-orm";
import { getBillingDb } from "../db.ts";
import { billingAccounts } from "../../drizzle/schema.ts";
import { COMPUTE_WARNING_THRESHOLD, getPlans, isPlanId } from "../config.ts";
import { getAppUrl } from "../platform.ts";
import { sendBillingEmail } from "../emails/send.ts";
import { billingSettingsUrl } from "../emails/layout.ts";
import { logger } from "../logger.ts";
import { SECONDS_PER_MINUTE, periodEndOf, periodStartOf } from "./period.ts";

/** What one settlement batch added to one org's month. */
export interface ComputeIncrement {
  orgId: string;
  periodStart: string;
  addedSeconds: number;
  /** The counter AFTER the increment. */
  secondsUsed: number;
}

/** Fire-and-forget: a warning must never fail, or delay, a settlement pass. */
export function emitComputeSignals(
  increments: readonly ComputeIncrement[],
  now = new Date(),
): void {
  void (async () => {
    for (const inc of increments) {
      try {
        await warnIfCrossed(inc, now);
      } catch (err) {
        logger.error("compute warning failed", {
          orgId: inc.orgId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  })();
}

async function warnIfCrossed(inc: ComputeIncrement, now: Date): Promise<void> {
  // A late settlement of a past month is history, not a warning about now.
  if (inc.periodStart !== periodStartOf(now)) return;

  const [account] = await getBillingDb()
    .select({ planId: billingAccounts.planId })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, inc.orgId));
  if (!account || !isPlanId(account.planId)) return;
  const plan = getPlans()[account.planId];
  const included = plan.includedComputeMinutes;
  if (included === null || included <= 0) return;

  const quotaSeconds = included * SECONDS_PER_MINUTE;
  const previous = (inc.secondsUsed - inc.addedSeconds) / quotaSeconds;
  const current = inc.secondsUsed / quotaSeconds;

  if (current >= 1) {
    logger.warn("Compute quota reached (new runs are refused until the month renews)", {
      orgId: inc.orgId,
      secondsUsed: inc.secondsUsed,
      includedMinutes: included,
    });
  }
  if (previous < COMPUTE_WARNING_THRESHOLD && current >= COMPUTE_WARNING_THRESHOLD) {
    sendBillingEmail(inc.orgId, "compute-warning", {
      planName: plan.name,
      usagePercent: Math.min(100, Math.round(current * 100)),
      minutesUsed: Math.floor(inc.secondsUsed / SECONDS_PER_MINUTE),
      minutesIncluded: included,
      resetDate: periodEndOf(inc.periodStart).toISOString(),
      upgradeUrl: billingSettingsUrl(getAppUrl()),
      locale: "fr",
    });
  }
}
