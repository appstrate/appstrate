// SPDX-License-Identifier: Apache-2.0

import { and, eq, like } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user } from "@appstrate/db/schema";
import { endOtherSessions, getAuth } from "@appstrate/db/auth";

/**
 * End every session of the platform accounts whose address is at exactly
 * `domain`, but `keepSessionId`. Resolves to the number of accounts. Accounts
 * of an end-user realm are untouched: their sessions answer to their space.
 */
export async function endSessionsForEmailDomain(
  domain: string,
  keepSessionId: string | null,
): Promise<number> {
  const normalized = domain.trim().toLowerCase();
  // A domain carries no `%` or `_` a caller could widen the match with: refuse
  // anything but a hostname rather than escape it.
  if (!/^[a-z0-9.-]+$/.test(normalized)) throw new Error(`not a domain: ${domain}`);
  const accounts = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.realm, "platform"), like(user.email, `%@${normalized}`)));
  const { internalAdapter } = await getAuth().$context;
  for (const account of accounts) {
    await endOtherSessions(internalAdapter, account.id, keepSessionId);
  }
  return accounts.length;
}
