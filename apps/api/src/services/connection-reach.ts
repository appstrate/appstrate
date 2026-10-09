// SPDX-License-Identifier: Apache-2.0

/**
 * Where an `integration_connections` row may be used. A row's scope is the tier of the client that
 * minted it: `space_id` set serves that space only, `space_id` NULL serves every space of its org —
 * except a space with its own manual OAuth client for the row's auth, unless the row was connected
 * from there (`origin_space_id`). Within that reach, an actor uses their own rows and the rows
 * shared into the space; `block_user_connections` restricts their own rows to the shared ones.
 *
 * Every predicate is over the unaliased `integration_connections` table.
 */

import { and, arrayContains, eq, isNull, not, or, sql, type SQL } from "drizzle-orm";
import {
  integrationConnections as c,
  integrationOauthClients as o,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import { actorFilter, type Actor } from "../lib/actor.ts";

/** The rows that may serve space `spaceId`, whoever owns them. */
export function connectionInSpace(spaceId: string): SQL {
  return and(
    eq(c.orgId, sql`(SELECT ${spaces.orgId} FROM ${spaces} WHERE ${spaces.id} = ${spaceId})`),
    or(
      eq(c.spaceId, spaceId),
      and(
        isNull(c.spaceId),
        or(
          eq(c.originSpaceId, spaceId),
          sql`NOT EXISTS (SELECT 1 FROM ${o} WHERE ${o.spaceId} = ${spaceId}
            AND ${o.integrationId} = ${c.integrationId} AND ${o.authKey} = ${c.authKey}
            AND NOT ${o.autoProvisioned})`,
        ),
      ),
    ),
  )!;
}

/** The owner shared the row into `spaceId`. */
function sharedInto(spaceId: string): SQL {
  return arrayContains(c.sharedSpaceIds, [spaceId]);
}

/** `block_user_connections` is on for the row's integration in `spaceId`. */
function blockedInSpace(spaceId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${spacePackages} WHERE ${spacePackages.spaceId} = ${spaceId}
    AND ${spacePackages.packageId} = ${c.integrationId} AND ${spacePackages.blockUserConnections})`;
}

/**
 * The actor's own rows reaching `spaceId`, blocked or not: what the owner manages (reconnect,
 * rename, delete). Use {@link usableInSpace} to decide what binds.
 */
export function ownRowInSpace(spaceId: string, actor: Actor): SQL {
  return and(connectionInSpace(spaceId), actorFilter(actor, c))!;
}

/** Rows shared into `spaceId` that reach it. */
export function sharedInSpace(spaceId: string): SQL {
  return and(connectionInSpace(spaceId), sharedInto(spaceId))!;
}

/** Rows the actor may bind in `spaceId`: own rows unless the space blocks them, ∪ {@link sharedInSpace}. */
export function usableInSpace(spaceId: string, actor: Actor): SQL {
  return and(
    connectionInSpace(spaceId),
    or(sharedInto(spaceId), and(actorFilter(actor, c), not(blockedInSpace(spaceId)))),
  )!;
}
