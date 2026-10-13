// SPDX-License-Identifier: Apache-2.0

/**
 * The writer of the credential proxy's call journal (`connection_calls`, described on the table).
 * Best-effort like `recordAudit`: a fault is logged and swallowed, so a proxied call never depends
 * on the journal; the route hands the promise to `trackAudit` (`services/audit.ts`), off its
 * response path, and graceful shutdown drains it.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { connectionCalls, integrationConnections } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { templateHost } from "@appstrate/afps-runtime/resolvers";
import { actorFromIds, type Actor } from "../../lib/actor.ts";
import { logger } from "../../lib/logger.ts";

// Caps on the text a caller writes.
const MAX_METHOD_LENGTH = 16;
const MAX_HOST_LENGTH = 255;

interface ConnectionCall {
  orgId: string;
  spaceId: string;
  connectionId: string;
  integrationId: string;
  /** Who acted; under an API key, the principal acting through it. */
  actor: Actor;
  apiKeyId: string | null;
  authMethod: string;
  /** The run the call named with `X-Run-Id`, as the route authorized it. */
  runId: string | null;
  method: string;
  /** The caller's target before substitution: its `{{field}}` placeholders as written. */
  target: string;
  /** The upstream's HTTP status as a string, or the proxy's own problem code. */
  outcome: string;
  durationMs: number;
  requestId: string;
}

/** Never throws: a database fault is logged and the row is lost. */
export async function recordConnectionCall(input: ConnectionCall): Promise<void> {
  try {
    const [connection] = await db
      .select({
        userId: integrationConnections.userId,
        endUserId: integrationConnections.endUserId,
      })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.id, input.connectionId),
          eq(integrationConnections.orgId, input.orgId),
        ),
      )
      .limit(1);
    const owner = connection ? actorFromIds(connection.userId, connection.endUserId) : null;
    await db.insert(connectionCalls).values({
      orgId: input.orgId,
      spaceId: input.spaceId,
      connectionId: input.connectionId,
      integrationId: input.integrationId,
      ownerType: owner?.type ?? null,
      ownerId: owner?.id ?? null,
      actorType: input.actor.type,
      actorId: input.actor.id,
      apiKeyId: input.apiKeyId,
      authMethod: input.authMethod,
      runId: input.runId,
      method: input.method.slice(0, MAX_METHOD_LENGTH),
      // Read on the template, never the substituted URL: a placeholder as written, so the row
      // holds no decrypted credential value.
      host: templateHost(input.target).slice(0, MAX_HOST_LENGTH),
      outcome: input.outcome,
      // A wall-clock difference: a clock stepped back mid-call reads negative.
      durationMs: Math.max(input.durationMs, 0),
      requestId: input.requestId,
    });
  } catch (err) {
    logger.error("recordConnectionCall failed (the proxied call is unaffected)", {
      connectionId: input.connectionId,
      integrationId: input.integrationId,
      requestId: input.requestId,
      error: getErrorMessage(err),
    });
  }
}
