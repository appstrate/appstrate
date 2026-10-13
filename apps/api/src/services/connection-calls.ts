// SPDX-License-Identifier: Apache-2.0

/**
 * Reads of the credential proxy's call journal (`connection_calls`, written by
 * `services/credential-proxy/call-journal.ts`). Two doors, one query: a connection's owner reads
 * every call made with it, whoever made it; a space's governor reads every call made in the space,
 * whatever the connection. Newest first, keyset-paginated on the row id.
 */

import { and, desc, eq, gte, lt, lte, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  connectionCalls,
  integrationConnections,
  type ConnectionCallRow,
} from "@appstrate/db/schema";
import type { ListEnvelope } from "@appstrate/shared-types";
import { actorFilter } from "../lib/actor.ts";
import type { ConnectionPrincipal } from "../lib/connection-principal.ts";
import { listResponse } from "../lib/list-response.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { meConnectionAuthorityFilter } from "./connection-reach.ts";

/** One journal row on the wire. */
export interface ConnectionCallView {
  id: number;
  createdAt: string;
  spaceId: string;
  connection_id: string;
  integration_package_id: string;
  owner_type: string | null;
  owner_id: string | null;
  actor_type: string;
  actor_id: string;
  apiKeyId: string | null;
  auth_method: string;
  runId: string | null;
  method: string;
  host: string;
  outcome: string;
  duration_ms: number;
  request_id: string | null;
}

export interface ConnectionCallFilters {
  connectionId?: string;
  actorId?: string;
  runId?: string;
  /** Inclusive bounds on `created_at`. */
  startDate?: Date;
  endDate?: Date;
}

export interface ConnectionCallPage {
  limit: number;
  /** The id of the last row of the previous page. */
  startingAfter?: number;
}

function toView(row: ConnectionCallRow): ConnectionCallView {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    spaceId: row.spaceId,
    connection_id: row.connectionId,
    integration_package_id: row.integrationId,
    owner_type: row.ownerType,
    owner_id: row.ownerId,
    actor_type: row.actorType,
    actor_id: row.actorId,
    apiKeyId: row.apiKeyId,
    auth_method: row.authMethod,
    runId: row.runId,
    method: row.method,
    host: row.host,
    outcome: row.outcome,
    duration_ms: row.durationMs,
    request_id: row.requestId,
  };
}

async function listCalls(
  reach: SQL | undefined,
  filters: ConnectionCallFilters,
  page: ConnectionCallPage,
): Promise<ListEnvelope<ConnectionCallView>> {
  const rows = await db
    .select()
    .from(connectionCalls)
    .where(
      and(
        reach,
        filters.connectionId ? eq(connectionCalls.connectionId, filters.connectionId) : undefined,
        filters.actorId ? eq(connectionCalls.actorId, filters.actorId) : undefined,
        filters.runId ? eq(connectionCalls.runId, filters.runId) : undefined,
        filters.startDate ? gte(connectionCalls.createdAt, filters.startDate) : undefined,
        filters.endDate ? lte(connectionCalls.createdAt, filters.endDate) : undefined,
        page.startingAfter !== undefined ? lt(connectionCalls.id, page.startingAfter) : undefined,
      ),
    )
    .orderBy(desc(connectionCalls.id))
    .limit(page.limit + 1);
  const hasMore = rows.length > page.limit;
  return listResponse((hasMore ? rows.slice(0, page.limit) : rows).map(toView), { hasMore });
}

/**
 * The calls made in `scope`'s space, whatever the connection and whoever owns it. A space id names
 * one space of one org; the org equality is defence in depth.
 */
export function listSpaceConnectionCalls(
  scope: SpaceScope,
  filters: ConnectionCallFilters,
  page: ConnectionCallPage,
): Promise<ListEnvelope<ConnectionCallView>> {
  return listCalls(
    and(eq(connectionCalls.orgId, scope.orgId), eq(connectionCalls.spaceId, scope.spaceId)),
    filters,
    page,
  );
}

/**
 * The calls made with a connection `principal` owns, whoever made them and from whichever space.
 * `null` for an unknown connection, one the caller does not own, or one outside a bound
 * credential's org (and space); a bound credential reads the calls of its org (and space) only.
 */
export async function listOwnConnectionCalls(
  principal: ConnectionPrincipal,
  connectionId: string,
  filters: Omit<ConnectionCallFilters, "connectionId">,
  page: ConnectionCallPage,
): Promise<ListEnvelope<ConnectionCallView> | null> {
  const [owned] = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, connectionId),
        actorFilter(principal.actor, integrationConnections),
        meConnectionAuthorityFilter(principal),
      ),
    )
    .limit(1);
  if (!owned) return null;
  const binding =
    principal.kind === "delegated"
      ? and(
          eq(connectionCalls.orgId, principal.orgId),
          principal.spaceId ? eq(connectionCalls.spaceId, principal.spaceId) : undefined,
        )
      : undefined;
  return listCalls(and(eq(connectionCalls.connectionId, owned.id), binding), filters, page);
}
