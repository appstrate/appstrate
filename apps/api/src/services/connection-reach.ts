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

import { and, asc, eq, isNull, not, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { ConnectionAction } from "@appstrate/shared-types";
import type { OrgRole } from "@appstrate/core/permissions";
import { displayAccountId } from "@appstrate/core/integration";
import {
  integrationConnectionShares as shares,
  integrationConnections as c,
  spacePackages,
  spaces,
} from "@appstrate/db/schema";
import { actorFilter, actorOwns, type Actor } from "../lib/actor.ts";
import {
  boundSpacesOf,
  reconnectScopeAllows,
  writesDelegated,
  type ConnectionPrincipal,
} from "../lib/connection-principal.ts";
import type { Permission } from "../lib/permissions.ts";

function orgOf(spaceId: string): SQL {
  return sql`(SELECT ${spaces.orgId} FROM ${spaces} WHERE ${spaces.id} = ${spaceId})`;
}

/** The rows that may serve space `spaceId`, whoever owns them. */
export function connectionInSpace(spaceId: string): SQL {
  return and(eq(c.orgId, orgOf(spaceId)), or(eq(c.spaceId, spaceId), isNull(c.spaceId)))!;
}

/** The row is shared into `spaceId` (a value, or a column of an outer query). */
export function sharedInto(spaceId: string | SQLWrapper): SQL {
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

/** The space's own `space_packages` row locks members' connections to the integration. */
export function userConnectionsBlocked(spaceId: string, integrationId: SQLWrapper | string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${spacePackages}
    WHERE ${spacePackages.spaceId} = ${spaceId} AND ${spacePackages.packageId} = ${integrationId}
    AND ${spacePackages.blockUserConnections})`;
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

/**
 * The rows of {@link usableInSpace} the actor owns: what a run of theirs could bind there, minus
 * the colleagues' shared rows. An own row a block keeps out is back in once shared into the space.
 */
export function ownUsableInSpace(spaceId: string, actor: Actor): SQL {
  return and(usableInSpace(spaceId, actor), actorFilter(actor, c))!;
}

/** The order candidates of equal standing keep, wherever the usable rows are listed. */
export const OLDEST_FIRST = [asc(c.createdAt), asc(c.id)] as const;

/**
 * In the SQL, so a bound credential only ever SELECTs rows inside its org and, when it names spaces,
 * rows serving one of them (an org-level row serves them all).
 */
export function meConnectionAuthorityFilter(principal: ConnectionPrincipal): SQL | undefined {
  const { binding } = principal;
  if (!binding) return undefined;
  return and(eq(c.orgId, binding.orgId), withinSpaces(binding.spaceIds, connectionInSpace));
}

/**
 * `predicate` holds for one of `spaceIds`; `undefined` (no bound) when `spaceIds` is `null`, and
 * FALSE for an empty list, which names no space at all.
 */
export function withinSpaces(
  spaceIds: readonly string[] | null,
  predicate: (spaceId: string) => SQL,
): SQL | undefined {
  if (spaceIds === null) return undefined;
  if (spaceIds.length === 0) return sql`FALSE`;
  return or(...spaceIds.map(predicate));
}

/** A space of an org the caller sees, with the caller's permissions there. */
export interface SpaceSeen {
  id: string;
  name: string;
  permissions: ReadonlySet<string>;
}

/** Who acts on connections, from where, and what they hold: every connection surface's one caller. */
export interface ConnectionCaller {
  principal: ConnectionPrincipal;
  /** The request space; `null` on the account surface, which acts from none. */
  spaceId: string | null;
  /** Holds `integrations:connect` where the credential acts. */
  canConnect: boolean;
  /** The credential permits org-wide consent; role and ownership are checked per row. */
  canShareAllSpaces?: (orgId: string) => boolean;
  /** Holds `integrations:configure` in `spaceId`. */
  governs: boolean;
  /** The credential may name this space at all (its pin, its allowlist): a share's target must be one. */
  admitsSpace: (spaceId: string) => boolean;
  /** The caller's permissions in one space of `orgId` (empty outside it). */
  permissionsIn: (spaceId: string, orgId: string) => Promise<ReadonlySet<Permission>>;
  /** Every space of `orgId` the caller sees under its role `orgRole` there, in one read. */
  spacesSeen: (orgId: string, orgRole: OrgRole | undefined) => Promise<SpaceSeen[]>;
}

/** Where the owner may share: `integrations:connect` there; `configures` also holds `configure`. */
interface ShareTargets {
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
      sql`EXISTS (SELECT 1 FROM ${spaces} WHERE ${spaces.id} = ${spaceId} AND ${spaces.ownerUserId} IS NULL)`,
      t.configures.has(spaceId) ? sql`TRUE` : not(userConnectionsBlocked(spaceId, c.integrationId)),
    )!,
  );
}

/**
 * The write actions `caller` holds on `row`: what the lists offer and the edit services enforce. The
 * owner renames (a credential bound to spaces: rows scoped to one of them only, never a row serving
 * the whole org) and shares a member's row;
 * a governor of the request space renames a colleague's row scoped to it and withdraws one shared
 * into it. Sharing is the owner's consent: a governor never shares.
 *
 * `reconnect` is the owner's too, whatever the row's health: renewing in place is refused unless
 * the stored account is identified (`persistCredentialBundle`), so an identity-less row never holds
 * it. The account surface acts from no space: it also needs one to start the renewal in
 * (`listMeConnections`).
 */
export function connectionActions(
  row: {
    orgId: string;
    userId: string | null;
    endUserId: string | null;
    spaceId: string | null;
    accountId: string;
  },
  caller: ConnectionCaller,
  sharedHere: boolean,
  orgRole?: OrgRole | null,
): ConnectionAction[] {
  if (!caller.canConnect) return [];
  const actions: ConnectionAction[] = [];
  if (actorOwns(caller.principal.actor, row)) {
    const bound = boundSpacesOf(caller.principal);
    const writesRow = bound === null || (row.spaceId !== null && bound.includes(row.spaceId));
    if (writesRow) actions.push("rename");
    if (
      writesRow &&
      displayAccountId(row.accountId) !== null &&
      reconnectScopeAllows(writesDelegated(caller.principal), row.spaceId, caller.spaceId)
    ) {
      actions.push("reconnect");
    }
    if (row.userId !== null) {
      actions.push("share");
      if (
        row.spaceId === null &&
        caller.canShareAllSpaces?.(row.orgId) &&
        caller.principal.binding === null &&
        (orgRole === "owner" || orgRole === "admin")
      )
        actions.push("share_all_spaces");
    }
    return actions;
  }
  if (!caller.governs || caller.spaceId === null) return actions;
  if (row.spaceId === caller.spaceId) actions.push("rename");
  if (sharedHere) actions.push("unshare_here");
  return actions;
}
