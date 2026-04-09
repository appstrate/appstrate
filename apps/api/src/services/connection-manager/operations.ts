// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import { logger } from "../../lib/logger.ts";
import { and, inArray } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { userProviderConnections, connectionProfiles } from "@appstrate/db/schema";
import {
  listConnections as listConnectionsRaw,
  listProviderCredentialIds,
  deleteConnection as deleteConnectionRaw,
  deleteConnectionById as deleteConnectionByIdRaw,
  validateScopes,
} from "@appstrate/connect";
import { type Actor, actorFilter } from "../../lib/actor.ts";
import type { ConnectionStatus } from "./status.ts";

export async function listActorConnections(
  profileId: string,
  orgId: string,
  applicationId: string,
): Promise<ConnectionStatus[]> {
  const credentialIds = await listProviderCredentialIds(db, applicationId);
  const connections = await listConnectionsRaw(db, profileId, orgId, credentialIds);
  return connections.map((c) => ({
    provider: c.providerId,
    status: c.needsReconnection ? ("needs_reconnection" as const) : ("connected" as const),
    connectionId: c.id,
    connectedAt: c.createdAt,
    scopesGranted: c.scopesGranted,
  }));
}

export async function disconnectProvider(
  provider: string,
  profileId: string,
  orgId: string,
  providerCredentialId: string,
): Promise<void> {
  await deleteConnectionRaw(db, profileId, provider, orgId, providerCredentialId);
  logger.info("Connection deleted", { provider, profileId, orgId, providerCredentialId });
}

export async function disconnectConnectionById(
  connectionId: string,
  actor: Actor,
  applicationId: string,
): Promise<void> {
  // Verify the connection belongs to a profile owned by this actor AND to the current app
  const credentialIds = await listProviderCredentialIds(db, applicationId);
  if (credentialIds.length === 0) {
    // App has no credentials configured — connection can't belong to this app
    throw new Error("Connection not found or not owned by actor");
  }
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
        inArray(userProviderConnections.providerCredentialId, credentialIds),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new Error("Connection not found or not owned by actor");
  }

  await deleteConnectionByIdRaw(db, connectionId);
  logger.info("Connection deleted by ID", {
    connectionId,
    applicationId,
    actorType: actor.type,
    actorId: actor.id,
  });
}

export async function deleteAllActorConnections(
  actor: Actor,
  applicationId: string,
): Promise<void> {
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

  // Scope deletion to the current application's credentials only
  const credentialIds = await listProviderCredentialIds(db, applicationId);
  if (credentialIds.length === 0) return;

  await db.delete(userProviderConnections).where(
    and(
      inArray(
        userProviderConnections.profileId,
        profiles.map((p) => p.id),
      ),
      inArray(userProviderConnections.providerCredentialId, credentialIds),
    ),
  );

  logger.info("All actor connections deleted for application", {
    actorType: actor.type,
    actorId: actor.id,
    applicationId,
  });
}

export { validateScopes };
