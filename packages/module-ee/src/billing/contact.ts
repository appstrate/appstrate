// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Billing contact — where invoices, receipts and payment alerts go
 * (RBAC spec §10).
 *
 * Two columns on `ee_billing_accounts`: `billing_email`, the one primary
 * address, and `billing_cc`, up to five addresses copied on every billing
 * email. Neither has to belong to a platform user — "send the invoices to
 * accounting@" is the case this exists for, and requiring a user account for it
 * would be requiring the finance team to be onboarded into the product.
 *
 * `billing_email` NULL is not "unset, nothing happens": it falls back to the
 * org's owners, resolved at send time. A live fallback rather than a copied
 * default, so an org that changes owners keeps reaching a real person without
 * anyone remembering to write here.
 *
 * The same address is the Stripe customer's `email`, which is what makes
 * Stripe's own receipts land in the right inbox instead of nowhere.
 */

import { z } from "zod";
import { eq } from "drizzle-orm";
import { getEeDb } from "../db.ts";
import { billingAccounts } from "../../drizzle/schema.ts";
import { getStripe } from "../stripe/client.ts";
import { getOrgQueries } from "../platform-org-queries.ts";
import { logger } from "../logger.ts";

/** Product cap on the CC list — see the schema comment for why it is not a CHECK. */
const MAX_BILLING_CC = 5;

/**
 * Wire shape of `PATCH /api/billing/contact`. Both fields are optional so a
 * caller may set one without restating the other; `billing_email: null` is the
 * explicit way to clear the contact and go back to the owner fallback.
 */
export const billingContactPatchSchema = z
  .object({
    billing_email: z.email().nullable().optional(),
    billing_cc: z.array(z.email()).max(MAX_BILLING_CC).optional(),
  })
  .strict();

export interface BillingContact {
  billingEmail: string | null;
  billingCc: string[];
}

/** The org's contact, or null when it has no billing account. */
export async function getBillingContact(orgId: string): Promise<BillingContact | null> {
  const db = getEeDb();
  const [account] = await db
    .select({
      billingEmail: billingAccounts.billingEmail,
      billingCc: billingAccounts.billingCc,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));
  return account ?? null;
}

/**
 * The address Stripe and the billing emails treat as "the" contact:
 * `billing_email`, else the org's first owner, else null for an org the
 * platform no longer knows (Stripe accepts a customer without an email; the
 * emails simply have no primary recipient and fall back to the CC list).
 */
export async function resolvePrimaryBillingEmail(
  orgId: string,
  billingEmail: string | null,
): Promise<string | null> {
  if (billingEmail) return billingEmail;
  const owners = await getOrgQueries().getOrgOwnerEmails(orgId);
  return owners[0] ?? null;
}

/**
 * Push the resolved primary address to the Stripe customer so Stripe's own
 * receipts follow it.
 *
 * Best-effort, and every caller runs it AFTER its local commit: the contact is
 * EE's record, and a Stripe outage must not refuse a change the org can see is
 * correct. A failed push is logged; the next checkout re-sends the address
 * anyway.
 */
async function pushPrimaryEmailToStripe(
  orgId: string,
  customerId: string,
  billingEmail: string | null,
): Promise<void> {
  const email = await resolvePrimaryBillingEmail(orgId, billingEmail);
  if (!email) return;
  try {
    await getStripe().customers.update(customerId, { email });
  } catch (err) {
    logger.error("Failed to push the billing contact to Stripe", {
      orgId,
      customerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Re-push the owner fallback after a member left the org.
 *
 * The fallback is resolved live for EE's own emails but COPIED into Stripe, so
 * when the owner it resolved to leaves, Stripe keeps sending receipts to an
 * ex-member until something re-sends it. Only an org with no explicit
 * `billing_email` and an existing Stripe customer has anything to re-send.
 */
export async function resyncOwnerFallbackToStripe(orgId: string): Promise<void> {
  const db = getEeDb();
  const [account] = await db
    .select({
      billingEmail: billingAccounts.billingEmail,
      stripeCustomerId: billingAccounts.stripeCustomerId,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));
  if (!account || account.billingEmail !== null || !account.stripeCustomerId) return;
  await pushPrimaryEmailToStripe(orgId, account.stripeCustomerId, null);
}

/**
 * Apply a validated patch and, when the primary address moved, push it to the
 * Stripe customer (see {@link pushPrimaryEmailToStripe}).
 *
 * Returns null when the org has no billing account.
 */
export async function updateBillingContact(
  orgId: string,
  patch: z.infer<typeof billingContactPatchSchema>,
): Promise<BillingContact | null> {
  const db = getEeDb();

  const [updated] = await db
    .update(billingAccounts)
    .set({
      ...(patch.billing_email !== undefined && { billingEmail: patch.billing_email }),
      ...(patch.billing_cc !== undefined && { billingCc: patch.billing_cc }),
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.orgId, orgId))
    .returning({
      billingEmail: billingAccounts.billingEmail,
      billingCc: billingAccounts.billingCc,
      stripeCustomerId: billingAccounts.stripeCustomerId,
    });

  if (!updated) return null;

  if (patch.billing_email !== undefined && updated.stripeCustomerId) {
    await pushPrimaryEmailToStripe(orgId, updated.stripeCustomerId, updated.billingEmail);
  }

  return { billingEmail: updated.billingEmail, billingCc: updated.billingCc };
}
