// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { getEeDb, type EeTx } from "../db.ts";
import { billingAccounts, freeTierClaims } from "../../drizzle/schema.ts";
import { eq } from "drizzle-orm";
import { getPlans } from "../config.ts";
import { syncOrgStorageEntitlement } from "../billing/storage-entitlement.ts";
import { drainOrgUsageOnDelete } from "../billing/org-drain.ts";
import { cancelSubscriptionAndCleanUp } from "../billing/org-cancellation.ts";
import { logger } from "../logger.ts";

/**
 * Normalize email to reduce free-tier abuse via aliases.
 * Strips Gmail dot-addressing and plus-addressing for all providers.
 */
export function normalizeEmail(email: string): string {
  const [local, domain] = email.toLowerCase().split("@");
  if (!local || !domain) return email.toLowerCase();
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return local.replace(/\./g, "").split("+")[0] + "@gmail.com";
  }
  return local.split("+")[0] + "@" + domain;
}

/**
 * Create the org's free-tier billing account, idempotently.
 *
 * Shared by `onOrgCreate` and the `repair:account` operator script, which
 * re-provisions an org whose account went missing (see
 * `billing/repair-account.ts`). Returns whether THIS call won the email's
 * non-renewable free-tier claim, i.e. whether the account was granted credits.
 *
 * Anti-abuse: the free-tier claim row is the serialization point. Insert it
 * FIRST and let the unique constraint pick the winner — only the caller whose
 * insert actually lands (RETURNING a row) is entitled to grant credits.
 *
 * A prior SELECT-then-grant lets two concurrent org creations for the same
 * email both observe "no claim" and both grant the free tier to two different
 * orgs (the ON CONFLICT dedups the claim row, but both accounts were already
 * credited). Deriving the grant from the insert win closes that race.
 *
 * THE CALLER OWNS THE TRANSACTION, and there must be one: a claim must never be
 * consumed without the matching account being created, or a failure between the
 * two burns the email's claim and leaves every future org for it at 0 credits.
 * Taking `tx` rather than opening one lets `repair:account` provision and apply
 * the recovered debt atomically — a repair that half-commits is worse than one
 * that never ran, because the account it leaves behind makes the org look
 * already repaired.
 *
 * `billingEmail` seeds the billing contact and is the address AS TYPED, not
 * `normalizedEmail`: normalization strips plus- and dot-addressing to make the
 * free-tier claim hard to alias, which is the right rule for a claim key and
 * the wrong one for an address a human reads.
 */
export async function provisionBillingAccount(
  tx: EeTx,
  orgId: string,
  normalizedEmail: string,
  billingEmail: string,
): Promise<{ freeTierGranted: boolean; creditQuota: number }> {
  const freePlan = getPlans().free;

  const [won] = await tx
    .insert(freeTierClaims)
    .values({ email: normalizedEmail })
    .onConflictDoNothing({ target: freeTierClaims.email })
    .returning({ email: freeTierClaims.email });

  await tx
    .insert(billingAccounts)
    .values({
      orgId,
      planId: "free",
      creditsUsed: 0,
      creditQuota: won ? freePlan.creditQuota : 0,
      periodEnd: null, // Non-renewable, no reset
      billingEmail,
    })
    .onConflictDoNothing({ target: billingAccounts.orgId });

  return {
    freeTierGranted: won !== undefined,
    creditQuota: won ? freePlan.creditQuota : 0,
  };
}

export async function onOrgCreate(orgId: string, userEmail: string): Promise<void> {
  const normalized = normalizeEmail(userEmail);
  const { freeTierGranted, creditQuota } = await getEeDb().transaction((tx) =>
    provisionBillingAccount(tx, orgId, normalized, userEmail),
  );

  if (freeTierGranted) {
    logger.info("Free tier credits allocated", { orgId, email: normalized, creditQuota });
  } else {
    logger.info("Free tier already claimed, billing account created with 0 credits", {
      orgId,
      email: normalized,
    });
  }

  // Project the free plan onto the platform storage limit. Independent of the
  // free-tier CREDIT claim (anti-abuse): storage is a plan entitlement, and a
  // 0-credit duplicate-email org still sits on the free plan. Best-effort —
  // the periodic resync repairs a miss.
  await syncOrgStorageEntitlement(orgId);
}

export async function onOrgDelete(orgId: string): Promise<void> {
  const db = getEeDb();

  // FINAL BILLING DRAIN — must run BEFORE anything below is deleted.
  //
  // The platform awaits this handler before cascading the org away, and it
  // refuses to delete an organization while a run is active — so at this instant
  // every one of the org's runner rows is terminal, hence settled, hence
  // billable. Without this drain, an org that spends and then deletes itself
  // inside one sweep interval (300 s by default) is never debited, and the
  // sweeper cannot even observe the loss: the ledger rows disappear with the
  // org. The drain never moves the global watermark — the periodic sweep
  // re-reads the same rows later and finds them already claimed.
  await drainOrgUsageOnDelete(orgId);

  const [account] = await db
    .select({ stripeSubscriptionId: billingAccounts.stripeSubscriptionId })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));

  // Runs whether or not an account row exists and is idempotent, so the platform may call
  // it again after a deletion that failed further along. Cancel, THEN delete: an
  // unconfirmed cancellation keeps the rows for the sweeper to retry, because dropping
  // them takes the subscription id with them.
  const subscriptionId = account?.stripeSubscriptionId ?? null;
  const done = await cancelSubscriptionAndCleanUp(orgId, subscriptionId);
  if (!done) {
    logger.error("org deleted with its Stripe subscription still live — queued for retry", {
      orgId,
      subscriptionId,
    });
  }
}
