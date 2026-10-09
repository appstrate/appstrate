// SPDX-License-Identifier: Apache-2.0

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";

import type { Actor } from "../lib/actor.ts";
import { actorFilter } from "../lib/actor.ts";
import type { SpaceScope } from "../lib/scope.ts";

/**
 * `scopesGranted` of a single connection row the actor owns — the row
 * being reconnected/upgraded, keyed by `connectionId`. The kickoff route
 * unions this into the re-consent request so an upgrade never silently
 * shrinks what that specific account already authorized (incremental
 * consent is per-account). A fresh connect has no `connectionId` and the
 * route skips this entirely, so it stays at the manifest default scopes.
 *
 * Actor-filtered for safety — a caller can't read another actor's granted
 * scopes by guessing a connection id.
 */
export async function getCurrentScopesGranted(input: {
  scope: SpaceScope;
  integrationId: string;
  authKey: string;
  actor: Actor;
  connectionId: string;
}): Promise<string[]> {
  const rows = await db
    .select({ scopesGranted: integrationConnections.scopesGranted })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, input.connectionId),
        eq(integrationConnections.integrationId, input.integrationId),
        eq(integrationConnections.authKey, input.authKey),
        eq(integrationConnections.spaceId, input.scope.spaceId),
        actorFilter(input.actor, {
          userId: integrationConnections.userId,
          endUserId: integrationConnections.endUserId,
        }),
      ),
    );
  return rows[0]?.scopesGranted ?? [];
}
