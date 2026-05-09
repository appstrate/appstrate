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
import type { AppScope, OrgScope } from "../../lib/scope.ts";

export async function listActorConnections(
  scope: AppScope,
  connectionProfileId: string,
): Promise<ConnectionStatus[]> {
  const credentialIds = await listProviderCredentialIds(db, scope.applicationId);
  const connections = await listConnectionsRaw(db, connectionProfileId, scope.orgId, credentialIds);
  return connections.map((c) => ({
    provider: c.providerId,
    status: c.needsReconnection ? ("needs_reconnection" as const) : ("connected" as const),
    connectionId: c.id,
    connectedAt: c.createdAt,
    scopesGranted: c.scopesGranted,
  }));
}

/**
 * Disconnect by provider+profile+org+credential. Genuinely org-scoped —
 * `providerCredentialId` already pins the app, so no `AppScope` is needed.
 * Callers at the route layer resolve the credential ID via
 * `getProviderCredentialId(applicationId, providerId)` first.
 */
export async function disconnectProvider(
  scope: OrgScope,
  provider: string,
  connectionProfileId: string,
  providerCredentialId: string,
): Promise<void> {
  await deleteConnectionRaw(db, connectionProfileId, provider, scope.orgId, providerCredentialId);
  logger.info("Connection deleted", {
    provider,
    connectionProfileId,
    orgId: scope.orgId,
    providerCredentialId,
  });
}

export async function disconnectConnectionById(
  scope: AppScope,
  connectionId: string,
  actor: Actor,
): Promise<void> {
  // Verify the connection belongs to a profile owned by this actor AND to the current app
  const credentialIds = await listProviderCredentialIds(db, scope.applicationId);
  if (credentialIds.length === 0) {
    // App has no credentials configured — connection can't belong to this app
    throw new Error("Connection not found or not owned by actor");
  }
  const rows = await db
    .select({ id: userProviderConnections.id })
    .from(userProviderConnections)
    .innerJoin(
      connectionProfiles,
      eq(userProviderConnections.connectionProfileId, connectionProfiles.id),
    )
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
    applicationId: scope.applicationId,
    actorType: actor.type,
    actorId: actor.id,
  });
}

export async function deleteAllActorConnections(scope: AppScope, actor: Actor): Promise<void> {
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
  const credentialIds = await listProviderCredentialIds(db, scope.applicationId);
  if (credentialIds.length === 0) return;

  await db.delete(userProviderConnections).where(
    and(
      inArray(
        userProviderConnections.connectionProfileId,
        profiles.map((p) => p.id),
      ),
      inArray(userProviderConnections.providerCredentialId, credentialIds),
    ),
  );

  logger.info("All actor connections deleted for application", {
    actorType: actor.type,
    actorId: actor.id,
    applicationId: scope.applicationId,
  });
}

export { validateScopes };
