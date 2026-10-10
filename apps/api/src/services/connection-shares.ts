// SPDX-License-Identifier: Apache-2.0

/**
 * Sharing a connection into a space and withdrawing it: one `integration_connection_shares` row
 * per (connection, space). Only the owner shares; the owner, or a governor of the request space,
 * withdraws. Lock order, as every other connection write: the owner's membership and the target
 * space (`assertConnectionShareable`), the connection row, then schedules.
 */

import type { Context } from "hono";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  integrationConnectionShares as shares,
  integrationConnections as c,
  type IntegrationConnectionRow as ConnectionRow,
} from "@appstrate/db/schema";
import type { OrgRole } from "@appstrate/core/permissions";
import type { AppEnv } from "../types/index.ts";
import type { Permission } from "../lib/permissions.ts";
import { ApiError, forbidden, notFound } from "../lib/errors.ts";
import { actorFilter, actorFromIds, actorOwns } from "../lib/actor.ts";
import { boundSpaceOf, type ConnectionPrincipal } from "../lib/connection-principal.ts";
import {
  connectionInSpace,
  ownRowInSpace,
  scopedOrSharedIn,
  type ShareTargets,
} from "./connection-reach.ts";
import {
  assertConnectionShareable,
  invalidShareTarget,
  type ConnectionShare,
} from "./space-members.ts";
import { assertConnectionsUnpinned } from "./integration-connections.ts";
import { disableForeignSchedules } from "./schedules-naming-connection.ts";
import { isUserConnectionCreationBlocked } from "./integration-connection-resolver.ts";
import { listSpacesForPrincipal } from "./spaces.ts";
import { recordAuditFromContext } from "./audit.ts";

export interface ConnectionViewer {
  principal: ConnectionPrincipal;
  /** The space the edit is made from; `null` on the account surface, where only the owner edits. */
  spaceId: string | null;
  /** The integration the route names; `null` on the account surface, which names none. */
  integrationId: string | null;
  /** Holds `integrations:configure` in `spaceId`. */
  governs: boolean;
  /** The viewer's permissions in a space — asked of each share target. */
  permissionsIn: (spaceId: string) => Promise<ReadonlySet<Permission>>;
}

interface ShareInput {
  connectionId: string;
  spaceId: string;
  viewer: ConnectionViewer;
}

/** Seen from a space: the owner's row reaching it, or any row a governor there may edit. */
export function visibleTo(viewer: ConnectionViewer, connectionId: string): SQL {
  const here = viewer.spaceId;
  const actor = viewer.principal.actor;
  return and(
    eq(c.id, connectionId),
    viewer.integrationId === null ? undefined : eq(c.integrationId, viewer.integrationId),
    here === null
      ? undefined
      : or(
          ownRowInSpace(here, actor),
          and(sql`(${actorFilter(actor, c)}) IS NOT TRUE`, scopedOrSharedIn(here)),
        ),
  )!;
}

function shareRow(connectionId: string, spaceId: string): SQL {
  return and(eq(shares.connectionId, connectionId), eq(shares.spaceId, spaceId))!;
}

function assertBoundTarget(viewer: ConnectionViewer, spaceId: string): void {
  const bound = boundSpaceOf(viewer.principal);
  if (bound !== null && spaceId !== bound) {
    throw forbidden(`A credential bound to space '${bound}' can only share into it or withdraw it`);
  }
}

/** Share the viewer's own connection into `spaceId`; `added: false` when it already was. */
export async function shareConnection(
  input: ShareInput,
): Promise<{ connection: ConnectionRow; added: boolean }> {
  const { connectionId, spaceId, viewer } = input;
  const visible = visibleTo(viewer, connectionId);
  const [read] = await db.select().from(c).where(visible).limit(1);
  if (!read) throw notFound(`Connection '${connectionId}' not found`);
  if (!actorOwns(viewer.principal.actor, read)) {
    if (viewer.spaceId === null) throw notFound(`Connection '${connectionId}' not found`);
    throw forbidden("Only the connection owner can share it");
  }
  assertBoundTarget(viewer, spaceId);
  // Roles resolve outside the transaction; the refusal applies only to a share this call adds.
  const permissions = await viewer.permissionsIn(spaceId);
  let refusal: ApiError | null = null;
  if (!permissions.has("integrations:connect")) {
    refusal = forbidden(`Sharing into space '${spaceId}' requires integrations:connect there`);
  } else if (
    !permissions.has("integrations:configure") &&
    (await isUserConnectionCreationBlocked(spaceId, read.integrationId))
  ) {
    refusal = new ApiError({
      status: 403,
      code: "connection_blocked_by_admin",
      title: "Connection Blocked by Admin",
      detail: `Personal connections to '${read.integrationId}' are disabled in space '${spaceId}': only a principal with integrations:configure there may share one into it.`,
    });
  }

  return db.transaction(async (tx) => {
    await assertConnectionShareable(tx, connectionId, [spaceId]);
    const [row] = await tx.select().from(c).where(visible).for("update");
    if (!row) throw notFound(`Connection '${connectionId}' not found`);
    const [existing] = await tx
      .select({ spaceId: shares.spaceId })
      .from(shares)
      .where(shareRow(connectionId, spaceId));
    if (existing) return { connection: row, added: false };
    if (refusal) throw refusal;
    const [serves] = await tx
      .select({ id: c.id })
      .from(c)
      .where(and(eq(c.id, connectionId), connectionInSpace(spaceId)));
    if (!serves) {
      throw invalidShareTarget(
        `This connection cannot serve space '${spaceId}': it is confined to its own space`,
      );
    }
    const actor = viewer.principal.actor;
    await tx
      .insert(shares)
      .values({
        connectionId,
        spaceId,
        orgId: row.orgId,
        sharedBy: actor.type === "user" ? actor.id : null,
      })
      .onConflictDoNothing();
    const [connection] = await tx
      .update(c)
      .set({ updatedAt: new Date() })
      .where(eq(c.id, connectionId))
      .returning();
    return { connection: connection!, added: true };
  });
}

/**
 * Withdraw a connection from `spaceId`, disabling other actors' schedules there naming it (the
 * caller removes their jobs); `removed: false` when it was not shared there.
 */
export async function unshareConnection(input: ShareInput): Promise<{
  connection: ConnectionRow;
  removed: boolean;
  disabledScheduleIds: string[];
}> {
  const { connectionId, spaceId, viewer } = input;
  const visible = visibleTo(viewer, connectionId);
  const [read] = await db.select().from(c).where(visible).limit(1);
  if (!read) throw notFound(`Connection '${connectionId}' not found`);
  if (!actorOwns(viewer.principal.actor, read)) {
    if (viewer.spaceId === null) throw notFound(`Connection '${connectionId}' not found`);
    if (!viewer.governs) {
      throw forbidden(
        "Only the connection owner or a principal with integrations:configure can update this connection",
      );
    }
    if (spaceId !== viewer.spaceId) throw forbidden("You may only withdraw this space");
  }
  assertBoundTarget(viewer, spaceId);

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(c).where(visible).for("update");
    if (!row) throw notFound(`Connection '${connectionId}' not found`);
    const [existing] = await tx
      .select({ spaceId: shares.spaceId })
      .from(shares)
      .where(shareRow(connectionId, spaceId));
    if (!existing) return { connection: row, removed: false, disabledScheduleIds: [] };
    await assertConnectionsUnpinned(
      tx,
      [connectionId],
      `Connection cannot be unshared from space '${spaceId}'`,
      spaceId,
    );
    await tx.delete(shares).where(shareRow(connectionId, spaceId));
    const [connection] = await tx
      .update(c)
      .set({ updatedAt: new Date() })
      .where(eq(c.id, connectionId))
      .returning();
    const owner = actorFromIds(connection!.userId, connection!.endUserId)!;
    const disabledScheduleIds = await disableForeignSchedules(
      tx,
      [{ id: connectionId, owner, inSpaceId: spaceId }],
      "connection_unshared",
    );
    return { connection: connection!, removed: true, disabledScheduleIds };
  });
}

/**
 * The spaces `userId` may share into: those they see where `permissionsIn` holds
 * `integrations:connect`; `configures` the ones also holding `integrations:configure`.
 */
export async function shareTargetSpaces(input: {
  orgId: string;
  orgRole: OrgRole;
  userId: string;
  /** A credential bound to a space shares into that space only. */
  boundSpaceId: string | null;
  permissionsIn: (spaceId: string) => Promise<ReadonlySet<Permission>>;
}): Promise<ShareTargets> {
  const visible = await listSpacesForPrincipal(
    input.orgId,
    input.orgRole,
    input.userId,
    input.userId,
  );
  const ids = [...new Set(visible.map(({ space }) => space.id))].filter(
    (id) => input.boundSpaceId === null || id === input.boundSpaceId,
  );
  const held = await Promise.all(ids.map((id) => input.permissionsIn(id)));
  const spaceIds: string[] = [];
  const configures = new Set<string>();
  ids.forEach((id, i) => {
    if (!held[i]!.has("integrations:connect")) return;
    spaceIds.push(id);
    if (held[i]!.has("integrations:configure")) configures.add(id);
  });
  return { spaceIds, configures };
}

/** One `integration.connection.share_removed` per withdrawn share, recorded in its space. */
export async function recordSharesRemoved(
  ctx: Context<AppEnv>,
  orgId: string,
  removed: readonly ConnectionShare[],
  reason?: "access_lost" | "space_deleted",
): Promise<void> {
  for (const share of removed) {
    await recordAuditFromContext(ctx, {
      action: "integration.connection.share_removed",
      resourceType: "integration_connection",
      resourceId: share.connectionId,
      after: { spaceId: share.spaceId, ...(reason ? { reason } : {}) },
      orgIdOverride: orgId,
      spaceIdOverride: share.spaceId,
    });
  }
}
