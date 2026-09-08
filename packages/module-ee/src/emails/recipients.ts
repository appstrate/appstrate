/**
 * Who a billing email goes to (RBAC spec §10):
 *
 *     billing_email ?? emails of org owners   ∪   billing_cc   ∪   billing managers
 *
 * This replaces a fan-out to every org admin. The old rule addressed people by
 * their platform role, which is the wrong axis for an invoice: an admin runs
 * agents, a billing contact pays for them, and the two are routinely different
 * people. Each of the three terms now names someone who asked to be told.
 *
 * The composition is a pure function so the combinations can be asserted
 * without a database; {@link resolveBillingRecipients} is the IO around it.
 */

import { eq } from "drizzle-orm";
import { getCloudDb } from "../db.ts";
import { billingAccounts } from "../../drizzle/schema.ts";
import { listBillingManagers } from "../billing/managers.ts";
import { getOrgQueries } from "../platform-org-queries.ts";

/**
 * Union the three terms, de-duplicated case-insensitively and in a stable
 * order: primary contact first, then CC, then managers.
 *
 * De-duplication is case-insensitive because the same person reaches the list
 * through two doors — typed by hand into `billing_email`, and read out of the
 * platform's user table for a manager — and mailbox names are compared
 * case-insensitively in practice. The FIRST spelling wins, so the address the
 * org typed is the one it sees.
 */
export function composeBillingRecipients(input: {
  billingEmail: string | null;
  ownerEmails: readonly string[];
  billingCc: readonly string[];
  managerEmails: readonly string[];
}): string[] {
  const primary = input.billingEmail ? [input.billingEmail] : input.ownerEmails;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const email of [...primary, ...input.billingCc, ...input.managerEmails]) {
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/**
 * Resolve the recipients for one org. Empty when the org has no billing
 * account — there is nothing to bill it for either.
 *
 * The owner lookup is skipped whenever a `billing_email` is set: the fallback
 * is the only thing it feeds, so an org that named its contact never pays for
 * the platform round-trip.
 */
export async function resolveBillingRecipients(orgId: string): Promise<string[]> {
  const db = getCloudDb();
  const [account] = await db
    .select({
      billingEmail: billingAccounts.billingEmail,
      billingCc: billingAccounts.billingCc,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));

  if (!account) return [];

  const managers = await listBillingManagers(orgId);
  const queries = getOrgQueries();
  const [ownerEmails, managerMembers] = await Promise.all([
    account.billingEmail ? Promise.resolve([]) : queries.getOrgOwnerEmails(orgId),
    managers.length === 0
      ? Promise.resolve([])
      : queries.getOrgMembers(
          orgId,
          managers.map((m) => m.userId),
        ),
  ]);

  return composeBillingRecipients({
    billingEmail: account.billingEmail,
    ownerEmails,
    billingCc: account.billingCc,
    managerEmails: managerMembers.map((m) => m.email),
  });
}
