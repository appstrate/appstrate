import { db } from "../../lib/db.ts";
import { logger } from "../../lib/logger.ts";
import { and, inArray } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { userProviderConnections, connectionProfiles } from "@appstrate/db/schema";
import {
  listConnections as listConnectionsRaw,
  deleteConnection as deleteConnectionRaw,
  deleteConnectionById as deleteConnectionByIdRaw,
  validateScopes,
} from "@appstrate/connect";
import { type Actor, actorFilter } from "../../lib/actor.ts";
import type { ConnectionStatus } from "./status.ts";

export async function listActorConnections(
  profileId: string,
  orgId: string,
): Promise<ConnectionStatus[]> {
  const connections = await listConnectionsRaw(db, profileId, orgId);
  return connections.map((c) => ({
    provider: c.providerId,
    status: "connected" as const,
    connectionId: c.id,
    connectedAt: c.createdAt,
    scopesGranted: c.scopesGranted,
  }));
}

export async function disconnectProvider(
  provider: string,
  profileId: string,
  orgId: string,
): Promise<void> {
  await deleteConnectionRaw(db, profileId, provider, orgId);
  logger.info("Connection deleted", { provider, profileId, orgId });
}

export async function disconnectConnectionById(connectionId: string, actor: Actor): Promise<void> {
  // Verify the connection belongs to a profile owned by this actor
  const rows = await db
    .select({ id: userProviderConnections.id })
    .from(userProviderConnections)
    .innerJoin(connectionProfiles, eq(userProviderConnections.profileId, connectionProfiles.id))
    .where(
      and(
        eq(userProviderConnections.id, connectionId),
        actorFilter(actor, {
          userId: connectionProfiles.userId,
          endUserId: connectionProfiles.endUserId,
        }),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new Error("Connection not found or not owned by actor");
  }

  await deleteConnectionByIdRaw(db, connectionId);
  logger.info("Connection deleted by ID", {
    connectionId,
    actorType: actor.type,
    actorId: actor.id,
  });
}

export async function deleteAllActorConnections(actor: Actor): Promise<void> {
  const profiles = await db
    .select({ id: connectionProfiles.id })
    .from(connectionProfiles)
    .where(
      actorFilter(actor, {
        userId: connectionProfiles.userId,
        endUserId: connectionProfiles.endUserId,
      }),
    );

  if (profiles.length === 0) return;

  await db.delete(userProviderConnections).where(
    inArray(
      userProviderConnections.profileId,
      profiles.map((p) => p.id),
    ),
  );

  logger.info("All actor connections deleted", { actorType: actor.type, actorId: actor.id });
}

export { validateScopes };
