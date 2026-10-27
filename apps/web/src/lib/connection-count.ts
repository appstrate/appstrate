// SPDX-License-Identifier: Apache-2.0

/**
 * How many of the caller's own connections each integration has in one space.
 *
 * The account list (`GET /api/me/connections`) crosses every org and space of the caller, so the
 * count keeps the rows the server's `connectionInSpace` lets reach THIS space
 * (`connection-reach.ts`): in the space's org, and either org-scoped or scoped to this space. Every
 * row of that list is the caller's own, so a colleague's shared connection is never counted. One
 * rule of `usableInSpace` is not mirrored: an integration whose `block_user_connections` is on here
 * keeps only the rows shared into the space or made in it, and the account list does not carry the
 * flag. For such an integration the count can exceed what the connection picker offers.
 */

interface CountableConnection {
  org: { id: string };
  /** The one space a space-scoped connection lives in; `null` for an org-scoped one. */
  space: { id: string } | null;
}

interface CountableGroup {
  source_id: string;
  connections: readonly CountableConnection[];
}

/** Connections per integration package id; an integration with none has no entry. */
export function connectionCountBySource(
  groups: readonly CountableGroup[],
  here: { orgId: string | null; spaceId: string | null },
): Map<string, number> {
  const counts = new Map<string, number>();
  if (here.orgId === null || here.spaceId === null) return counts;
  for (const group of groups) {
    const count = group.connections.filter(
      (connection) =>
        connection.org.id === here.orgId &&
        (connection.space === null || connection.space.id === here.spaceId),
    ).length;
    if (count > 0) counts.set(group.source_id, count);
  }
  return counts;
}
