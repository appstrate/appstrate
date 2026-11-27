// SPDX-License-Identifier: Apache-2.0

/**
 * The bell notices to a connection's owner: its credential died (one call per
 * `needs_reconnection` false-to-true flip), or a server asked it for scopes it does not hold.
 */

import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, packages } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import type { CredentialNeedsReconnectionParams } from "@appstrate/core/module";
import { logger } from "../lib/logger.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";
import { getPackageDisplayName } from "../lib/package-helpers.ts";
import { findPersonalSpace } from "./spaces.ts";
import {
  createCredentialNeedsReconnectionNotification,
  createScopesRequestedNotification,
} from "./state/notifications.ts";

/** A connection and its owner, as an announcement names them. */
interface ConnectionOwner {
  orgId: string;
  /** `null` for an org-level connection serving every space of the organization. */
  spaceId: string | null;
  connectionId: string;
  owner: { type: "user" | "end_user"; id: string };
}

/** What every notice to the owner shows, and the space it is written in. */
interface OwnerNotice {
  spaceId: string;
  packageId: string;
  integration_name: string;
  label: string;
}

/**
 * The notice's space is the connection's, else the space it was connected from, else the owner's
 * personal space (never created here); none: `null`, and the notice is skipped.
 */
async function readOwnerNotice(target: ConnectionOwner): Promise<OwnerNotice | null> {
  const [row] = await db
    .select({
      label: integrationConnections.label,
      originSpaceId: integrationConnections.originSpaceId,
      packageId: packages.id,
      draftManifest: packages.draftManifest,
    })
    .from(integrationConnections)
    .innerJoin(packages, eq(packages.id, integrationConnections.integrationId))
    .where(eq(integrationConnections.id, target.connectionId))
    .limit(1);
  if (!row) return null;
  const spaceId =
    target.spaceId ??
    row.originSpaceId ??
    (target.owner.type === "user"
      ? ((await findPersonalSpace(target.orgId, target.owner.id))?.id ?? null)
      : null);
  if (!spaceId) {
    logger.warn("connection notice: no space to notify the owner in", {
      connectionId: target.connectionId,
      ownerType: target.owner.type,
    });
    return null;
  }
  return {
    spaceId,
    packageId: row.packageId,
    integration_name: getPackageDisplayName({
      id: row.packageId,
      draftManifest: row.draftManifest,
    }),
    label: row.label,
  };
}

/** Write the owner's notice off the main path: best effort, never throws. */
function notifyOwner(
  target: ConnectionOwner,
  what: string,
  write: (notice: OwnerNotice) => Promise<void>,
): void {
  readOwnerNotice(target)
    .then((notice) => (notice ? write(notice) : undefined))
    .catch((err) => logger.warn(`${what}: notification failed`, { error: getErrorMessage(err) }));
}

/** Best effort, never throws. Bell notice for integration connections only (no model-credential recipient, #1310). */
export function announceCredentialNeedsReconnection(
  params: CredentialNeedsReconnectionParams,
): void {
  if (params.kind === "integration_connection") {
    notifyOwner(params, "credential needs reconnection", ({ spaceId, ...notice }) =>
      createCredentialNeedsReconnectionNotification({
        orgId: params.orgId,
        spaceId,
        recipient: params.owner,
        payload: { ...notice, cause: params.cause },
      }),
    );
  }
  void emitEvent("onCredentialNeedsReconnection", params);
}

/**
 * Tell a connection's owner that a server asked it for scopes it does not hold, so they can
 * reconnect it with them. Called when the demand gained a scope; best effort, never throws.
 */
export function announceRequestedScopes(target: ConnectionOwner): void {
  notifyOwner(target, "requested scopes", ({ spaceId, ...notice }) =>
    createScopesRequestedNotification({
      orgId: target.orgId,
      spaceId,
      recipient: target.owner,
      payload: { ...notice, connection_id: target.connectionId },
    }),
  );
}
