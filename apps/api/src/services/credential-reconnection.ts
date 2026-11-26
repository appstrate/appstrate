// SPDX-License-Identifier: Apache-2.0

/**
 * The announcement of a credential's death. Every writer of `needs_reconnection = true` calls
 * {@link announceCredentialNeedsReconnection} when, and only when, its own write flipped the flag
 * from false to true: one announcement per death, whichever path flagged it.
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, packages } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import type { CredentialNeedsReconnectionParams } from "@appstrate/core/module";
import { logger } from "../lib/logger.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";
import { findPersonalSpace } from "./spaces.ts";
import { createCredentialNeedsReconnectionNotification } from "./state/notifications.ts";

type IntegrationDeath = Extract<
  CredentialNeedsReconnectionParams,
  { kind: "integration_connection" }
>;

/**
 * The bell notice for the connection's owner, in the connection's space, else the space it was
 * connected from, else the owner's personal space (never created here); none: skipped.
 */
async function notifyConnectionOwner(params: IntegrationDeath): Promise<void> {
  const [row] = await db
    .select({
      label: integrationConnections.label,
      originSpaceId: integrationConnections.originSpaceId,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, params.connectionId))
    .limit(1);
  if (!row) return;
  const [integration] = await db
    .select({ manifest: packages.draftManifest })
    .from(packages)
    .where(eq(packages.id, params.integrationId))
    .limit(1);
  const integrationName = (integration?.manifest as { display_name?: unknown } | null)
    ?.display_name;
  const spaceId =
    params.spaceId ??
    row.originSpaceId ??
    (params.owner.type === "user"
      ? ((await findPersonalSpace(params.orgId, params.owner.id))?.id ?? null)
      : null);
  if (!spaceId) {
    logger.warn("credential needs reconnection: no space to notify the owner in", {
      connectionId: params.connectionId,
      ownerType: params.owner.type,
    });
    return;
  }
  await createCredentialNeedsReconnectionNotification({
    orgId: params.orgId,
    spaceId,
    recipient: params.owner,
    payload: {
      kind: "integration_connection",
      packageId: params.integrationId,
      integration_name: typeof integrationName === "string" ? integrationName : null,
      connection_id: params.connectionId,
      label: row.label,
      auth_key: params.authKey,
      cause: params.cause,
    },
  });
}

/**
 * Fire-and-forget; never throws into the refresh path. Writes the bell notice (integration
 * connections only: a model-provider credential has no recipient decided yet, #1310) and emits
 * `onCredentialNeedsReconnection`.
 */
export function announceCredentialNeedsReconnection(
  params: CredentialNeedsReconnectionParams,
): void {
  const failed = (step: string) => (err: unknown) =>
    logger.warn(`credential needs reconnection: ${step} failed`, {
      kind: params.kind,
      error: getErrorMessage(err),
    });
  if (params.kind === "integration_connection") {
    notifyConnectionOwner(params).catch(failed("notification"));
  }
  emitEvent("onCredentialNeedsReconnection", params).catch(failed("event"));
}
