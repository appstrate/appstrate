import { db } from "../../lib/db.ts";
import { logger } from "../../lib/logger.ts";
import { eq, and, inArray } from "drizzle-orm";
import { serviceConnections, connectionProfiles } from "@appstrate/db/schema";
import {
  listConnections as listConnectionsRaw,
  deleteConnection as deleteConnectionRaw,
  deleteConnectionById as deleteConnectionByIdRaw,
  validateScopes,
} from "@appstrate/connect";
import type { ConnectionStatus } from "./status.ts";

export async function listUserConnections(
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

export async function disconnectConnectionById(
  connectionId: string,
  userId: string,
): Promise<void> {
  // Verify the connection belongs to a profile owned by this user
  const rows = await db
    .select({ id: serviceConnections.id })
    .from(serviceConnections)
    .innerJoin(connectionProfiles, eq(serviceConnections.profileId, connectionProfiles.id))
    .where(and(eq(serviceConnections.id, connectionId), eq(connectionProfiles.userId, userId)))
    .limit(1);

  if (rows.length === 0) {
    throw new Error("Connection not found or not owned by user");
  }

  await deleteConnectionByIdRaw(db, connectionId);
  logger.info("Connection deleted by ID", { connectionId, userId });
}

export async function deleteAllUserConnections(userId: string): Promise<void> {
  const profiles = await db
    .select({ id: connectionProfiles.id })
    .from(connectionProfiles)
    .where(eq(connectionProfiles.userId, userId));

  if (profiles.length === 0) return;

  await db.delete(serviceConnections).where(
    inArray(
      serviceConnections.profileId,
      profiles.map((p) => p.id),
    ),
  );

  logger.info("All user connections deleted", { userId });
}

export { validateScopes };
