// SPDX-License-Identifier: Apache-2.0

/**
 * Admission of a platform run against its plan's compute limits: the concurrency cap and the
 * monthly compute-minutes quota. Called from the `beforeUsage` hook, before the credit quote.
 *
 * What it gates, and what it deliberately does not:
 *
 * - **Only a run that owns platform compute** (`context: "run"`, `executionPlane:
 *   "platform"`, a `timeoutSeconds` bound). A remote run occupies the caller's host; a chat
 *   turn is not metered; and the system-proxy seam admits the inference of a run ALREADY
 *   running (`timeoutSeconds: null`), which must never be refused here: a started run is
 *   never killed for lack of minutes, it finishes and is settled afterwards.
 * - **BYOK runs are gated too.** The model credential decides who pays the LLM, not who
 *   occupies the sandbox: an org on its own API key still consumes minutes.
 * - **Minutes are a soft cap, by design.** Nothing is reserved at admission; the counter
 *   moves when a run finishes. The overshoot is bounded by the concurrency cap times the
 *   longest a run may last.
 * - **Concurrency is enforced exactly elsewhere.** The check below is only the EARLY refusal
 *   (it spares a launch the pipeline work, and says which plan's cap it hit): `runningCount`
 *   is read before the run row exists, so racing launches all pass it. The authoritative cap
 *   is `maxConcurrentRunsOf`, answered through the `runLimits` hook and enforced by the
 *   platform in the transaction that inserts the run, under the org admission lock.
 * - **An org with no billing account is not gated**, like the credit check: it predates the
 *   module and has no plan to read a limit from.
 */

import type { BeforeUsageParams, UsageRejection } from "@appstrate/core/module";
import { eq } from "drizzle-orm";
import { getBillingDb } from "../db.ts";
import { billingAccounts } from "../../drizzle/schema.ts";
import { getPlans, isPlanId } from "../config.ts";
import { periodEndOf, periodStartOf, quotaStanding } from "./period.ts";
import { readComputeSecondsUsed } from "./usage.ts";

type RunParams = Extract<BeforeUsageParams, { context: "run" }>;

/**
 * The plan's cap on runs in flight for `orgId`, as the `runLimits` hook answers it, or `null`
 * for an org with no account or a plan that sets none (the deployment-wide cap alone).
 */
export async function maxConcurrentRunsOf(orgId: string): Promise<number | null> {
  const [account] = await getEeDb()
    .select({ planId: billingAccounts.planId })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));
  if (!account || !isPlanId(account.planId)) return null;
  return getPlans()[account.planId].maxConcurrentRuns;
}

/** Does this admission attempt own the run's platform compute? */
export function ownsPlatformCompute(params: BeforeUsageParams): params is RunParams {
  return (
    params.context === "run" &&
    params.executionPlane === "platform" &&
    params.timeoutSeconds !== null
  );
}

/**
 * The refusal for an org that has reached its plan's compute limits, or `null` to admit.
 * Throws on an unreadable billing database: the caller fails CLOSED.
 */
export async function checkComputeAdmission(
  params: RunParams,
  now: Date = new Date(),
): Promise<UsageRejection | null> {
  const [account] = await getBillingDb()
    .select({ planId: billingAccounts.planId })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, params.orgId));
  if (!account || !isPlanId(account.planId)) return null;
  const plan = getPlans()[account.planId];

  // Concurrency first: no read needed. `runningCount` already counts the run being admitted.
  if (plan.maxConcurrentRuns !== null && params.runningCount > plan.maxConcurrentRuns) {
    return {
      code: "org_run_concurrency_exceeded",
      message: `The ${plan.name} plan allows ${plan.maxConcurrentRuns} concurrent runs. Wait for a run to finish, or upgrade to the Team plan for more.`,
      status: 429,
    };
  }

  if (plan.includedComputeMinutes !== null) {
    const usedSeconds = await readComputeSecondsUsed(params.orgId, now);
    if (quotaStanding(usedSeconds, plan.includedComputeMinutes).exhausted) {
      const renewal = periodEndOf(periodStartOf(now)).toISOString().slice(0, 10);
      return {
        code: "compute_quota_exceeded",
        message: `The ${plan.name} plan's ${plan.includedComputeMinutes.toLocaleString("en-US")} compute minutes are used up for this month. New runs resume on ${renewal}, or upgrade to the Team plan to keep running now. Runs already started are not interrupted.`,
        status: 402,
      };
    }
  }
  return null;
}
