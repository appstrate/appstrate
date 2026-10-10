// SPDX-License-Identifier: Apache-2.0

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";

import type { Actor } from "../lib/actor.ts";
import { ownRowInSpace } from "./connection-reach.ts";
import type { ReconnectTarget } from "./integration-connections.ts";

/**
 * The connection a reconnect or scope upgrade targets: the actor's own row of this integration and
 * auth reaching the space, read once per connect. Its `scopesGranted` are unioned into the
 * re-consent request, so an upgrade never silently shrinks what that account already authorized;
 * its `spaceId` says whether the reconnect resolves an org-tier client. `null` when the id names
 * no such row, so a caller cannot read another actor's row by guessing its id.
 */
export async function readReconnectTarget(input: {
  connectionId: string;
  spaceId: string;
  integrationId: string;
  authKey: string;
  actor: Actor;
}): Promise<ReconnectTarget | null> {
  const [row] = await db
    .select({
      id: integrationConnections.id,
      spaceId: integrationConnections.spaceId,
      label: integrationConnections.label,
      scopesGranted: integrationConnections.scopesGranted,
    })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, input.connectionId),
        eq(integrationConnections.integrationId, input.integrationId),
        eq(integrationConnections.authKey, input.authKey),
        ownRowInSpace(input.spaceId, input.actor),
      ),
    )
    .limit(1);
  return row ?? null;
}
