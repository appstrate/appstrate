// SPDX-License-Identifier: Apache-2.0

/**
 * The writer of the call journal (`connection_calls`, described on the table). Best-effort like
 * `recordAudit`: a fault is logged and swallowed, so a call never depends on the journal; the route hands the promise to `trackAudit` (`services/audit.ts`), off its
 * response path, and graceful shutdown drains it.
 */

import type { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { connectionCalls, integrationConnections } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { actorFromIds, issuingChatSessionId, type Actor } from "../../lib/actor.ts";
import { logger } from "../../lib/logger.ts";
import type { AppEnv } from "../../types/index.ts";

// Caps on the text a caller writes.
const MAX_METHOD_LENGTH = 16;
const MAX_HOST_LENGTH = 255;

export interface ConnectionCall {
  orgId: string;
  spaceId: string;
  /** NULL when the integration binds no connection (unauthenticated, AFPS §7.2): no owner either. */
  connectionId: string | null;
  integrationId: string;
  /** Who acted; under an API key, the principal acting through it. */
  actor: Actor;
  apiKeyId: string | null;
  authMethod: string;
  /** The run the call belongs to: named with `X-Run-Id`, or the run whose sidecar reported it. */
  runId: string | null;
  /** The conversation whose loopback bearer issued the call; NULL when `runId` is set. */
  chatSessionId: string | null;
  method: string;
  /**
   * The target's host as its template names it (`templateHost`): a `{{field}}` as written, never
   * a decrypted value. NULL for an operation of a local MCP server, whose upstream is not seen.
   */
  host: string | null;
  /** The upstream's HTTP status as a string, or the proxy's own problem code. */
  outcome: string;
  durationMs: number;
  requestId: string;
}

/** Who called, as the journal records it: read from the request by {@link proxyCaller} alone. */
export type ProxyCaller = Pick<
  ConnectionCall,
  "apiKeyId" | "authMethod" | "requestId" | "chatSessionId"
>;

/**
 * The caller of a proxied call or MCP operation, from its request. A call naming a run records
 * the run alone, the narrower context: a row names at most one (`connection_calls_one_context`).
 */
export function proxyCaller(c: Context<AppEnv>, runId: string | null): ProxyCaller {
  return {
    apiKeyId: c.get("apiKeyId") || null,
    authMethod: c.get("authMethod"),
    requestId: c.get("requestId"),
    chatSessionId: runId === null ? issuingChatSessionId(c) : null,
  };
}

/** The owner of each connection the rows name, by id; a batch is one organization's. */
async function connectionOwners(rows: readonly ConnectionCall[]): Promise<Map<string, Actor>> {
  const named = rows.filter((row) => row.connectionId !== null);
  const owners = new Map<string, Actor>();
  if (named.length === 0) return owners;
  const found = await db
    .select({
      id: integrationConnections.id,
      userId: integrationConnections.userId,
      endUserId: integrationConnections.endUserId,
    })
    .from(integrationConnections)
    .where(
      and(
        inArray(integrationConnections.id, [...new Set(named.map((row) => row.connectionId!))]),
        eq(integrationConnections.orgId, named[0]!.orgId),
      ),
    );
  for (const connection of found) {
    const owner = actorFromIds(connection.userId, connection.endUserId);
    if (owner) owners.set(connection.id, owner);
  }
  return owners;
}

/**
 * Writes the rows in one statement, in their order (the `id` sequence follows it). Never throws:
 * a database fault is logged and the rows are lost.
 */
export async function recordConnectionCalls(rows: readonly ConnectionCall[]): Promise<void> {
  try {
    const owners = await connectionOwners(rows);
    await db.insert(connectionCalls).values(
      rows.map((row) => {
        const owner = row.connectionId ? owners.get(row.connectionId) : null;
        return {
          orgId: row.orgId,
          spaceId: row.spaceId,
          connectionId: row.connectionId,
          integrationId: row.integrationId,
          ownerType: owner?.type ?? null,
          ownerId: owner?.id ?? null,
          actorType: row.actor.type,
          actorId: row.actor.id,
          apiKeyId: row.apiKeyId,
          authMethod: row.authMethod,
          runId: row.runId,
          chatSessionId: row.chatSessionId,
          method: row.method.slice(0, MAX_METHOD_LENGTH),
          host: row.host?.slice(0, MAX_HOST_LENGTH) ?? null,
          outcome: row.outcome,
          // A wall-clock difference: a clock stepped back mid-call reads negative.
          durationMs: Math.max(row.durationMs, 0),
          requestId: row.requestId,
        };
      }),
    );
  } catch (err) {
    logger.error("recordConnectionCalls failed (the calls are unaffected)", {
      records: rows.length,
      integrationIds: [...new Set(rows.map((row) => row.integrationId))],
      requestIds: [...new Set(rows.map((row) => row.requestId))],
      error: getErrorMessage(err),
    });
  }
}
