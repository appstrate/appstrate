import { getCloudDb } from "../db.ts";
import { billingAccounts } from "../../drizzle/schema.ts";
import { eq } from "drizzle-orm";
import { ENDED_SUBSCRIPTION_STATUSES, HARD_BLOCKED_STATUSES } from "../config.ts";
import type { UsageQuote } from "./usage-quote.ts";

export class QuotaExceededError extends Error {
  readonly code = "QUOTA_EXCEEDED" as const;
  readonly orgId: string;
  readonly reason: "budget" | "status" | "no_account";

  constructor(orgId: string, reason: "budget" | "status" | "no_account") {
    const messages: Record<string, string> = {
      budget: `Credit quota exceeded for org ${orgId}`,
      status: `Subscription blocked for org ${orgId}`,
      no_account: `No billing account for org ${orgId}`,
    };
    super(messages[reason]);
    this.name = "QuotaExceededError";
    this.orgId = orgId;
    this.reason = reason;
  }
}

/** The balance-bearing fields of a billing account. */
export interface AccountBalance {
  creditsUsed: number;
  creditQuota: number;
}

/**
 * The balance rule, isolated as a pure predicate so it is testable without a
 * database and so there is exactly ONE place the comparison can drift.
 *
 * `remaining = max(0, creditQuota - creditsUsed)` — clamped so an already-
 * settled overshoot (`used > quota`, which the soft cap permits by design)
 * reads as "nothing left" rather than a negative allowance that would make
 * arithmetic downstream nonsensical.
 *
 * Affordable iff `totalCredits <= remaining`, i.e. rejection is STRICTLY
 * greater. A quote exactly equal to the remaining balance is affordable and is
 * admitted: it fits. The previous `used + estimate >= quota` rule rejected it,
 * and — worse — rejected a genuinely free operation on an empty account, since
 * `0 + 0 >= 0` holds.
 *
 * Entitlement (`subscriptionStatus`) is deliberately NOT an input here: status
 * policy is separate from balance arithmetic and is applied in
 * {@link checkQuota} before this predicate.
 */
export function isAffordable(quote: UsageQuote, account: AccountBalance): boolean {
  const remaining = Math.max(0, account.creditQuota - account.creditsUsed);
  return quote.totalCredits <= remaining;
}

/**
 * Admission check against the org's billing account, given a usage quote.
 *
 * SOFT CAP BY DESIGN: this is a read-only admission gate, not a hard
 * reservation. The quote is a pessimistic estimate of what the operation will
 * cost (per-context: a run multiplies the projected in-flight count — INCLUDING
 * the run being admitted — by the per-run model estimate, a chat turn uses a
 * flat per-turn estimate; see `quoteUsage`) and exists to discourage concurrent
 * overshoot, but nothing is reserved or debited here — usage admitted in the
 * same instant can still collectively exceed the quota by its actual cost.
 * The billing sweep (the `llm_usage` cursor) is the source of truth and will
 * record the overshoot (logged as "soft cap overshoot"). Tightening this to a
 * hard cap would require an atomic reserve-on-admit / settle-on-finish design;
 * intentionally deferred — the soft cap is acceptable for current plans.
 *
 * Checks, in order — the order is the contract:
 *
 * 1. `no_account` — rejects ONLY when the quote is positive. A missing billing
 *    account cannot owe anything, so a zero-cost operation (e.g. a
 *    platform-hosted BYOK run while compute is unbilled) must still be
 *    admitted. This asymmetry is deliberate: rejecting it would be a hard
 *    regression for orgs created before the billing module existed, which
 *    legitimately have no account row.
 * 2. `status` — `unpaid` / `paused` are hard blocks. `canceled` /
 *    `incomplete_expired` mean the paid entitlement ended: zero-cost usage is
 *    still admitted, while a positive quote is rejected. This preserves BYOK
 *    access while compute is unbilled without letting ended subscriptions draw
 *    paid model or future compute credits.
 * 3. `budget` — delegated to the pure {@link isAffordable} predicate, which
 *    owns the `remaining = max(0, creditQuota - creditsUsed)` clamp and the
 *    strictly-greater rejection rule. This function contributes only the
 *    account read.
 *
 * Allows usage during:
 * - active, trialing, past_due (grace period during Stripe dunning)
 * - free tier (subscriptionStatus is null)
 * - canceled / incomplete_expired when the quote is exactly zero
 *
 * Callers that established the operation is fully self-funded (neither a
 * platform credential nor platform compute) short-circuit BEFORE calling this —
 * see the `beforeUsage` hook — so no billing DB read happens for them at all.
 *
 * @param quote - the per-component credit estimate from `quoteUsage`.
 */
export async function checkQuota(orgId: string, quote: UsageQuote): Promise<void> {
  const db = getCloudDb();

  const [account] = await db
    .select({
      creditsUsed: billingAccounts.creditsUsed,
      creditQuota: billingAccounts.creditQuota,
      subscriptionStatus: billingAccounts.subscriptionStatus,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));

  if (!account) {
    // Nothing to charge against — only reject if there IS something to charge.
    if (quote.totalCredits > 0) {
      throw new QuotaExceededError(orgId, "no_account");
    }
    return;
  }

  // A canceled subscription means the paid entitlement ended; it is not an
  // account suspension. Zero-cost usage remains available, while any usage
  // that needs credits still requires a paid entitlement.
  const status = account.subscriptionStatus;
  const hardBlocked = status !== null && HARD_BLOCKED_STATUSES.has(status);
  const endedPaidEntitlement = status !== null && ENDED_SUBSCRIPTION_STATUSES.has(status);
  if (hardBlocked || (endedPaidEntitlement && quote.totalCredits > 0)) {
    throw new QuotaExceededError(orgId, "status");
  }

  // Balance: the arithmetic lives in the pure predicate.
  if (!isAffordable(quote, account)) {
    throw new QuotaExceededError(orgId, "budget");
  }
}
