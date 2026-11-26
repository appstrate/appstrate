// SPDX-License-Identifier: Apache-2.0

/** Announces a credential's death: one call per `needs_reconnection` false-to-true flip. */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, packages } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import type { CredentialNeedsReconnectionParams } from "@appstrate/core/module";
import { logger } from "../lib/logger.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";
import { getPackageDisplayName } from "../lib/package-helpers.ts";
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
      packageId: packages.id,
      draftManifest: packages.draftManifest,
    })
    .from(integrationConnections)
    .innerJoin(packages, eq(packages.id, integrationConnections.integrationId))
    .where(eq(integrationConnections.id, params.connectionId))
    .limit(1);
  if (!row) return;
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
      packageId: params.packageId,
      integration_name: getPackageDisplayName({
        id: row.packageId,
        draftManifest: row.draftManifest,
      }),
      label: row.label,
      cause: params.cause,
    },
  });
}

/** Best effort, never throws. Bell notice for integration connections only (no model-credential recipient, #1310). */
export function announceCredentialNeedsReconnection(
  params: CredentialNeedsReconnectionParams,
): void {
  if (params.kind === "integration_connection") {
    notifyConnectionOwner(params).catch((err) =>
      logger.warn("credential needs reconnection: notification failed", {
        error: getErrorMessage(err),
      }),
    );
  }
  void emitEvent("onCredentialNeedsReconnection", params);
}
