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

import { and, eq, isNull, not, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { ConnectionAction } from "@appstrate/shared-types";
import {
  integrationConnectionShares as shares,
  integrationConnections as c,
  packageShares,
  packages,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import { actorFilter, actorOwns, type Actor } from "../lib/actor.ts";
import { boundSpaceOf, type ConnectionPrincipal } from "../lib/connection-principal.ts";
import { placementReadFilter, placementShareJoin } from "./package-placement.ts";

function orgOf(spaceId: string): SQL {
  return sql`(SELECT ${spaces.orgId} FROM ${spaces} WHERE ${spaces.id} = ${spaceId})`;
}

/** The rows that may serve space `spaceId`, whoever owns them. */
export function connectionInSpace(spaceId: string): SQL {
  return and(eq(c.orgId, orgOf(spaceId)), or(eq(c.spaceId, spaceId), isNull(c.spaceId)))!;
}

/** The row is shared into `spaceId`. */
export function sharedInto(spaceId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${shares} WHERE ${shares.connectionId} = ${c.id} AND ${shares.spaceId} = ${spaceId})`;
}

/**
 * Of `spaceIds`, those where `predicate` holds for the row in scope, as a `text[]`. Every predicate
 * is nested in the array expression, so drizzle qualifies its columns in a select field too.
 */
function spacesWhere(
  spaceIds: readonly string[],
  predicate: (spaceId: string) => SQL,
): SQL<string[]> {
  if (spaceIds.length === 0) return sql<string[]>`ARRAY[]::text[]`;
  const cases = sql.join(
    spaceIds.map((spaceId) => sql`CASE WHEN ${predicate(spaceId)} THEN ${spaceId}::text END`),
    sql`, `,
  );
  return sql<string[]>`array_remove(ARRAY[${cases}], NULL)`;
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

/** In the SQL, so a delegated credential only ever SELECTs rows inside its org (and space). */
export function meConnectionAuthorityFilter(principal: ConnectionPrincipal): SQL | undefined {
  if (principal.kind !== "delegated") return undefined;
  return and(
    eq(c.orgId, principal.orgId),
    principal.spaceId ? connectionInSpace(principal.spaceId) : undefined,
  );
}

/** Who reads a connection list, and what they hold in the request space (`null`: none). */
export interface ConnectionReader {
  principal: ConnectionPrincipal;
  spaceId: string | null;
  /** Holds `integrations:connect`. */
  canConnect: boolean;
  /** Holds `integrations:configure` in `spaceId`. */
  governs: boolean;
}

/** Where the owner may share: `integrations:connect` there; `configures` also holds `configure`. */
export interface ShareTargets {
  spaceIds: string[];
  configures: ReadonlySet<string>;
}

/**
 * Of `t.spaceIds`, those the row may be shared into: it reaches the space, and personal connections
 * of its integration are not blocked there unless the owner also configures it.
 */
export function shareableIn(t: ShareTargets): SQL<string[]> {
  return spacesWhere(t.spaceIds, (spaceId) =>
    and(
      connectionInSpace(spaceId),
      t.configures.has(spaceId) ? sql`TRUE` : not(userConnectionsBlocked(spaceId, c.integrationId)),
    )!,
  );
}

/**
 * The write actions `reader` holds on `row`, as the share and rename services enforce them. The
 * owner renames (a credential bound to a space: rows scoped to it only) and shares a member's row;
 * a governor of the request space renames a colleague's row scoped to it and withdraws one shared
 * into it. Sharing is the owner's consent: a governor never shares.
 */
export function connectionActions(
  row: { userId: string | null; endUserId: string | null; spaceId: string | null },
  reader: ConnectionReader,
  sharedHere: boolean,
): ConnectionAction[] {
  if (!reader.canConnect) return [];
  const actions: ConnectionAction[] = [];
  if (actorOwns(reader.principal.actor, row)) {
    const bound = boundSpaceOf(reader.principal);
    if (bound === null || row.spaceId === bound) actions.push("rename");
    if (row.userId !== null) actions.push("share");
    return actions;
  }
  if (!reader.governs || reader.spaceId === null) return actions;
  if (row.spaceId === reader.spaceId) actions.push("rename");
  if (sharedHere) actions.push("unshare_here");
  return actions;
}
