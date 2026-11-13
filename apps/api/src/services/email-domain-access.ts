// SPDX-License-Identifier: Apache-2.0

import { and, eq, like } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user } from "@appstrate/db/schema";
import { endOtherAccessAfterCredentialChange, getAuth } from "@appstrate/db/auth";

/**
 * End everything a password change ends (`endOtherAccessAfterCredentialChange`:
 * sessions but `keepSessionId`, sign-in links, social-link states, pairings,
 * and the tokens modules revoke on that event) for every platform account whose
 * address is at exactly `domain`. Idempotent. Resolves to the number of
 * accounts. Accounts of an end-user realm are untouched: they answer to their space.
 */
export async function endAccessForEmailDomain(
  domain: string,
  keepSessionId: string | null,
): Promise<number> {
  const normalized = domain.trim().toLowerCase();
  // A domain carries no `%` or `_` a caller could widen the match with: refuse
  // anything but a hostname rather than escape it.
  if (!/^[a-z0-9.-]+$/.test(normalized)) throw new Error(`not a domain: ${domain}`);
  const accounts = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(and(eq(user.realm, "platform"), like(user.email, `%@${normalized}`)));
  const { internalAdapter } = await getAuth().$context;
  for (const account of accounts) {
    await endOtherAccessAfterCredentialChange(internalAdapter, account, keepSessionId);
  }
  return accounts.length;
}
