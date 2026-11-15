// SPDX-License-Identifier: Apache-2.0

/**
 * How many of the caller's own connections an integration has in a space of the org.
 *
 * The account list (`GET /api/me/connections`) crosses every org and space of the caller, so the
 * count keeps the rows the server's `connectionInSpace` lets reach THAT space
 * (`connection-reach.ts`): in the space's org, and either org-scoped or scoped to that space. Every
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

/** Connections of one integration package id in one space of `orgId`; 0 before the org is known. */
export function connectionCounter(
  groups: readonly CountableGroup[],
  orgId: string | null,
): (sourceId: string, spaceId: string) => number {
  const bySource = new Map(groups.map((group) => [group.source_id, group.connections]));
  return (sourceId, spaceId) =>
    orgId === null
      ? 0
      : (bySource.get(sourceId) ?? []).filter(
          (connection) =>
            connection.org.id === orgId &&
            (connection.space === null || connection.space.id === spaceId),
        ).length;
}
