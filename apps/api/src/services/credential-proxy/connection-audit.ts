// SPDX-License-Identifier: Apache-2.0

/**
 * Audit of the credential proxy's use of a connection the caller does not own: one row per
 * X-Session-Id and connection (a session is the unit its owner reviews, not a call).
 */

import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";
import { getCache } from "../../infra/index.ts";
import { actorFromIds, type Actor } from "../../lib/actor.ts";
import type { AppEnv } from "../../types/index.ts";
import { recordAuditFromContext } from "../audit.ts";

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
  const first = await cache.set(`cp:audited:${input.sessionId}:${input.connectionId}`, "1", {
    ttlSeconds: input.sessionTtlSeconds,
    nx: true,
  });
  if (!first) return;
  const [row] = await db
    .select({ userId: integrationConnections.userId, endUserId: integrationConnections.endUserId })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, input.connectionId))
    .limit(1);
  const owner = row ? actorFromIds(row.userId, row.endUserId) : null;
  if (owner && owner.type === input.actor.type && owner.id === input.actor.id) return;
  await recordAuditFromContext(c, {
    action: "integration.connection.proxied",
    resourceType: "integration_connection",
    resourceId: input.connectionId,
    after: {
      packageId: input.integrationId,
      sessionId: input.sessionId,
      runId: input.runId,
      ownerType: owner?.type ?? null,
      ownerId: owner?.id ?? null,
    },
  });
}
