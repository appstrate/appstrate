// SPDX-License-Identifier: Apache-2.0

/**
 * Audit of the credential proxy's use of a connection the caller does not own: one row per
 * X-Session-Id, acting principal and connection (a session is the unit its owner reviews, not a
 * call).
 */

import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";
import { getCache } from "../../infra/index.ts";
import { actorFromIds, type Actor } from "../../lib/actor.ts";
import type { AppEnv } from "../../types/index.ts";
import { tryRecordAuditFromContext } from "../audit.ts";

export async function auditForeignConnectionUse(
  c: Context<AppEnv>,
  input: {
    actor: Actor;
    connectionId: string;
    integrationId: string;
    sessionId: string;
    runId: string | null;
    sessionTtlSeconds: number;
  },
): Promise<void> {
  const cache = await getCache();
  const key = `cp:audited:${input.sessionId}:${input.actor.type}:${input.actor.id}:${input.connectionId}`;
  if (!(await cache.set(key, "1", { ttlSeconds: input.sessionTtlSeconds, nx: true }))) return;
  let settled = false;
  try {
    const [row] = await db
      .select({
        userId: integrationConnections.userId,
        endUserId: integrationConnections.endUserId,
      })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, input.connectionId))
      .limit(1);
    const owner = row ? actorFromIds(row.userId, row.endUserId) : null;
    settled =
      (owner !== null && owner.type === input.actor.type && owner.id === input.actor.id) ||
      (await tryRecordAuditFromContext(c, {
        action: "integration.connection.proxied",
        resourceType: "integration_connection",
        resourceId: input.connectionId,
        after: {
          packageId: input.integrationId,
          sessionId: input.sessionId,
          runId: input.runId,
          // Under an API key the row's actor is the key; this names who acted through it.
          principalType: input.actor.type,
          principalId: input.actor.id,
          ownerType: owner?.type ?? null,
          ownerId: owner?.id ?? null,
        },
      }));
  } finally {
    // No row written: release the key so the session's next call retries the audit.
    if (!settled) await cache.del(key);
  }
}
