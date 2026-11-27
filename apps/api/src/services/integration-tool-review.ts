// SPDX-License-Identifier: Apache-2.0

/**
 * Asking the people who govern an integration to review the tools its server offered: who is asked
 * and whether, judged from the snapshots, the space policies and the reach of each holder.
 */

import { eq } from "drizzle-orm";
import { allowsUndeclaredTools } from "@appstrate/core/integration";
import { getErrorMessage } from "@appstrate/core/errors";
import { db } from "@appstrate/db/client";
import { spaces, type NotificationPayloads } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { listSpacePermissionHolders } from "../lib/space-role.ts";
import { usersReachingConnection } from "./integration-connections.ts";
import { readIntegrationManifestForConnect } from "./integration-service.ts";
import {
  resolveEffectiveToolCatalog,
  loadToolSpacePoliciesForSpaces,
} from "./integration-tool-catalog.ts";
import { readToolSnapshots } from "./integration-tool-snapshot-reads.ts";
import { insertToolReviewNotifications } from "./state/notifications.ts";
import { spacesActiveForAll } from "./space-packages.ts";

/**
 * Ask the people who govern an integration to review the tools its server just offered or
 * changed (`integration_tools_review`), after a snapshot recorded `names` as new or changed.
 *
 * Silent when the catalog is open (undeclared tools are usable there). Per space where the
 * integration is active, only when one of `names` is still `pending` there (not declared, blocked
 * or approved at its current definition); recipients are the `integrations:configure` holders of
 * that space who reach the snapshot's connection among their usable ones (no connection:
 * every holder). One unread notice per (space, recipient, integration): the partial unique index
 * absorbs the rest. Never throws: a snapshot caller must not fail on it.
 */
export async function scheduleToolReviewNotifications(params: {
  orgId: string;
  packageId: string;
  connectionId: string | null;
  names: readonly string[];
}): Promise<void> {
  try {
    const { orgId, packageId, connectionId, names } = params;
    const read = await readIntegrationManifestForConnect({ orgId }, packageId);
    if (!read.ok || allowsUndeclaredTools(read.manifest)) return;

    const orgSpaces = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.orgId, orgId));
    const active = await spacesActiveForAll(
      orgId,
      [packageId],
      orgSpaces.map((s) => s.id),
    );

    const payload: NotificationPayloads["integration_tools_review"] = {
      packageId,
      display_name: read.manifest.display_name ?? packageId,
    };
    // Read once for every space: the snapshot, then the approvals and blocks of all of them.
    const [snapshots, policyBySpace] = await Promise.all([
      readToolSnapshots({ orgId, packageId, connectionIds: [connectionId] }),
      loadToolSpacePoliciesForSpaces(orgId, [...active], packageId, read.manifest),
    ]);
    for (const spaceId of active) {
      const catalog = resolveEffectiveToolCatalog({
        integration: read.manifest,
        policy: policyBySpace.get(spaceId)!,
        snapshots,
      });
      if (!catalog.some((entry) => entry.status === "pending" && names.includes(entry.name))) {
        continue;
      }
      const holders = await listSpacePermissionHolders(spaceId, "integrations", "configure");
      const recipients =
        connectionId === null
          ? holders
          : await usersReachingConnection(spaceId, connectionId, holders);
      await insertToolReviewNotifications({
        orgId,
        spaceId,
        recipientUserIds: recipients,
        payload,
      });
    }
  } catch (err) {
    logger.warn("tool review notifications not scheduled", {
      packageId: params.packageId,
      error: getErrorMessage(err),
    });
  }
}
