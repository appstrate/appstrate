// SPDX-License-Identifier: Apache-2.0

/**
 * The credential proxy's call journal (`connection_calls`): one row per call that may have sent a
 * connection's credential, whatever its outcome. `routes/credential-proxy.ts` writes it for a call
 * the upstream answered and for one that failed after dispatch, never for a refusal decided before
 * anything was sent. Best-effort like `recordAudit`: a fault is logged and swallowed, so a proxied
 * call never depends on the journal; the route hands the promise to `trackAudit`
 * (`services/audit.ts`), off its response path, and graceful shutdown drains it.
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { connectionCalls, integrationConnections } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import { templateLocation } from "@appstrate/afps-runtime/resolvers";
import { actorFromIds, type Actor } from "../../lib/actor.ts";
import { logger } from "../../lib/logger.ts";

const MAX_METHOD_LENGTH = 16;
const MAX_HOST_LENGTH = 255;
const MAX_PATH_LENGTH = 2048;
const MAX_OUTCOME_LENGTH = 64;
/** The `integer` column's upper bound. */
const MAX_DURATION_MS = 2_147_483_647;

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
  requestId: string | null;
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
      .where(eq(integrationConnections.id, input.connectionId))
      .limit(1);
    const owner = connection ? actorFromIds(connection.userId, connection.endUserId) : null;
    // Read on the template, never the substituted URL: no userinfo, query string or fragment, a
    // placeholder as written, so neither half holds a decrypted credential value.
    const { host, path } = templateLocation(input.target);
    const durationMs = Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : 0;
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
      method: input.method.toUpperCase().slice(0, MAX_METHOD_LENGTH),
      host: host.slice(0, MAX_HOST_LENGTH),
      path: path.slice(0, MAX_PATH_LENGTH),
      outcome: input.outcome.slice(0, MAX_OUTCOME_LENGTH),
      durationMs: Math.min(Math.max(durationMs, 0), MAX_DURATION_MS),
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
