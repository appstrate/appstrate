// SPDX-License-Identifier: Apache-2.0

/**
 * Where an `integration_connections` row may be used. A row's scope is the tier of the client that
 * minted it: `space_id` set serves that space only, `space_id` NULL serves every space of its org.
 * Within that reach, an actor uses their own rows and the rows shared into the space;
 * `block_user_connections` restricts their own rows to the shared ones and those made in the space
 * (`coalesce(space_id, origin_space_id)`: they passed its creation gate, or predate the block).
 *
 * Every predicate is over the unaliased `integration_connections` table.
 */

import {
  and,
  arrayContains,
  eq,
  isNull,
  not,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import {
  integrationConnections as c,
  packageShares,
  packages,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import { actorFilter, type Actor } from "../lib/actor.ts";
import { placementReadFilter, placementShareJoin } from "./package-placement.ts";

function orgOf(spaceId: string): SQL {
  return sql`(SELECT ${spaces.orgId} FROM ${spaces} WHERE ${spaces.id} = ${spaceId})`;
}

/** The rows that may serve space `spaceId`, whoever owns them. */
export function connectionInSpace(spaceId: string): SQL {
  return and(eq(c.orgId, orgOf(spaceId)), or(eq(c.spaceId, spaceId), isNull(c.spaceId)))!;
}

function sharedInto(spaceId: string): SQL {
  return arrayContains(c.sharedSpaceIds, [spaceId]);
}

/** Read off a PLACEMENT row only: an orphan `space_packages` row is nobody's decision here. */
export function userConnectionsBlocked(spaceId: string, integrationId: SQLWrapper | string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${spacePackages}
    INNER JOIN ${packages} ON ${packages.id} = ${spacePackages.packageId}
    LEFT JOIN ${packageShares} ON ${placementShareJoin(spacePackages.packageId, spaceId)}
    WHERE ${spacePackages.spaceId} = ${spaceId} AND ${spacePackages.packageId} = ${integrationId}
    AND ${spacePackages.blockUserConnections} AND ${placementReadFilter(spaceId)!})`;
}

/** An own row the actor may bind in `spaceId`: unblocked there, or made there. */
function ownUsableIn(spaceId: string, actor: Actor): SQL {
  return and(
    actorFilter(actor, c),
    or(
      not(userConnectionsBlocked(spaceId, c.integrationId)),
      sql`coalesce(${c.spaceId}, ${c.originSpaceId}) = ${spaceId}`,
    ),
  )!;
}

/** The actor's own rows reaching `spaceId`, blocked or not: what the owner manages. */
export function ownRowInSpace(spaceId: string, actor: Actor): SQL {
  return and(connectionInSpace(spaceId), actorFilter(actor, c))!;
}

/** Rows scoped to or shared into `spaceId`, reaching it or not: what its governor may withdraw. */
export function scopedOrSharedIn(spaceId: string): SQL {
  return and(eq(c.orgId, orgOf(spaceId)), or(eq(c.spaceId, spaceId), sharedInto(spaceId)))!;
}

export function sharedInSpace(spaceId: string): SQL {
  return and(connectionInSpace(spaceId), sharedInto(spaceId))!;
}

export function usableInSpace(spaceId: string, actor: Actor): SQL {
  return and(connectionInSpace(spaceId), or(sharedInto(spaceId), ownUsableIn(spaceId, actor)))!;
}

export type MeConnectionAuthority =
  { kind: "user_global" } | { kind: "bound"; orgId: string; spaceId?: string };

/** In the SQL, so a bound credential only ever SELECTs rows inside its org (and space). */
export function meConnectionAuthorityFilter(authority: MeConnectionAuthority): SQL | undefined {
  if (authority.kind !== "bound") return undefined;
  return and(
    eq(c.orgId, authority.orgId),
    authority.spaceId ? connectionInSpace(authority.spaceId) : undefined,
  );
}
