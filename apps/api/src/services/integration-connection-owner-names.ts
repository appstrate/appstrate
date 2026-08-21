// SPDX-License-Identifier: Apache-2.0

/**
 * Owner display-name resolution for `integration_connections` rows.
 *
 * A connection is owned either by a dashboard user (`user_id`) or by an
 * end-user (`end_user_id`) — never both (DB check constraint). Any surface
 * that lists connections the caller does not own has to say *whose* they
 * are, which means one batched lookup per owner kind.
 *
 * Extracted here because two independent readers need the exact same
 * resolution and must not drift on the end-user fallback rule
 * (`name` first, then `externalId`): the picker
 * (`listAccessibleConnections`) and the integration settings list
 * (`listIntegrationConnections`).
 */

import { inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { endUsers, user } from "@appstrate/db/schema";

/** The owner columns any caller must project for a name lookup. */
interface ConnectionOwnerRef {
  userId: string | null;
  endUserId: string | null;
}

/**
 * Resolves an owner display name for a connection row, or `null` when the
 * owner row is gone (deleted member/end-user) — never throws on a dangling
 * owner, the connection itself is still a legitimate row.
 */
type OwnerNameLookup = (row: ConnectionOwnerRef) => string | null;

/**
 * Two batched lookups (users + end-users) over the distinct owner ids in
 * `rows`, returned as a synchronous lookup. Issues no query for an owner
 * kind that does not appear in `rows`, so the single-kind case (the common
 * one — a dashboard-only application) costs one query, not two.
 */
export async function resolveConnectionOwnerNames(
  rows: ReadonlyArray<ConnectionOwnerRef>,
): Promise<OwnerNameLookup> {
  const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => v !== null))];
  const endUserIds = [
    ...new Set(rows.map((r) => r.endUserId).filter((v): v is string => v !== null)),
  ];

  const [userRows, endUserRows] = await Promise.all([
    userIds.length
      ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds))
      : Promise.resolve([] as { id: string; name: string }[]),
    endUserIds.length
      ? db
          .select({ id: endUsers.id, name: endUsers.name, externalId: endUsers.externalId })
          .from(endUsers)
          .where(inArray(endUsers.id, endUserIds))
      : Promise.resolve([] as { id: string; name: string | null; externalId: string | null }[]),
  ]);

  const userNames = new Map(userRows.map((u) => [u.id, u.name]));
  // End-users may have no `name` (created via API with an `externalId` only);
  // the external id is the only stable human-facing handle in that case.
  const endUserNames = new Map(endUserRows.map((e) => [e.id, e.name ?? e.externalId]));

  return (row) => {
    if (row.userId) return userNames.get(row.userId) ?? null;
    if (row.endUserId) return endUserNames.get(row.endUserId) ?? null;
    return null;
  };
}
