// SPDX-License-Identifier: Apache-2.0

/**
 * The edits of a connection: renaming it, sharing it into a space and withdrawing it (one
 * `integration_connection_shares` row per (connection, space)). Each edit authorizes on the locked
 * row by the actions {@link connectionActions} projects, so what a list offers is what an edit
 * accepts. Lock order, as every other connection write: the owner's membership and the target
 * space (`assertConnectionShareable`) or the label keys, the connection row, then schedules.
 */

import type { Context } from "hono";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  integrationConnectionShares as shares,
  integrationConnections as c,
  type IntegrationConnectionRow as ConnectionRow,
} from "@appstrate/db/schema";
import type { OrgRole } from "@appstrate/core/permissions";
import type { AppEnv } from "../types/index.ts";
import { ApiError, conflict, forbidden, notFound } from "../lib/errors.ts";
import { isUniqueViolation, type Tx } from "../lib/db-helpers.ts";
import { actorFilter, actorFromIds } from "../lib/actor.ts";
import { boundSpaceOf } from "../lib/connection-principal.ts";
import {
  connectionActions,
  meConnectionAuthorityFilter,
  ownRowInSpace,
  scopedOrSharedIn,
  shareableIn,
  type ConnectionCaller,
} from "./connection-reach.ts";
import {
  assertConnectionShareable,
  invalidShareTarget,
  type ConnectionShare,
} from "./space-members.ts";
import { assertConnectionsUnpinned, lockLabelKeys } from "./integration-connections.ts";
import { disableForeignSchedules } from "./schedules-naming-connection.ts";
import { isUserConnectionCreationBlocked } from "./integration-connection-resolver.ts";
import { recordAudit, recordAuditFromContext } from "./audit.ts";

interface EditInput {
  connectionId: string;
  /** The integration the route names; `null` on the account surface, which names none. */
  integrationId: string | null;
  caller: ConnectionCaller;
}

interface ShareInput extends EditInput {
  spaceId: string;
}

/**
 * The row as the caller reaches it: from a space, the owner's row reaching it or any row a
 * governor there may edit; from the account surface, its own row inside the credential's binding.
 */
function visibleTo(input: EditInput): SQL {
  const { caller, connectionId, integrationId } = input;
  const here = caller.spaceId;
  const actor = caller.principal.actor;
  return and(
    eq(c.id, connectionId),
    integrationId === null ? undefined : eq(c.integrationId, integrationId),
    here === null
      ? and(actorFilter(actor, c), meConnectionAuthorityFilter(caller.principal))
      : or(
          ownRowInSpace(here, actor),
          and(sql`(${actorFilter(actor, c)}) IS NOT TRUE`, scopedOrSharedIn(here)),
        ),
  )!;
}

function connectionNotFound(connectionId: string): ApiError {
  return notFound(`Connection '${connectionId}' not found`);
}

/** The locked row the caller reaches: 404 when it reaches none. */
async function lockVisible(tx: Tx, input: EditInput): Promise<ConnectionRow> {
  const [row] = await tx.select().from(c).where(visibleTo(input)).for("update");
  if (!row) throw connectionNotFound(input.connectionId);
  return row;
}

function assertBoundTarget(caller: ConnectionCaller, spaceId: string): void {
  const bound = boundSpaceOf(caller.principal);
  if (bound !== null && spaceId !== bound) {
    throw forbidden(`A credential bound to space '${bound}' can only share into it or withdraw it`);
  }
}

function shareRow(connectionId: string, spaceId: string): SQL {
  return and(eq(shares.connectionId, connectionId), eq(shares.spaceId, spaceId))!;
}

async function touch(tx: Tx, connectionId: string): Promise<ConnectionRow> {
  const [row] = await tx
    .update(c)
    .set({ updatedAt: new Date() })
    .where(eq(c.id, connectionId))
    .returning();
  return row!;
}

/**
 * Rename a connection (`rename` action). The keys a row may hold are locked before the row, so
 * the row is read first for them.
 */
export async function renameConnection(
  input: EditInput & { label: string },
): Promise<ConnectionRow> {
  const [read] = await db
    .select({
      orgId: c.orgId,
      integrationId: c.integrationId,
      spaceId: c.spaceId,
      userId: c.userId,
      endUserId: c.endUserId,
    })
    .from(c)
    .where(visibleTo(input))
    .limit(1);
  if (!read) throw connectionNotFound(input.connectionId);
  return db
    .transaction(async (tx) => {
      // A row only widens (space → org): both keys it may hold.
      const key = {
        orgId: read.orgId,
        integrationId: read.integrationId,
        ownerId: (read.userId ?? read.endUserId)!,
      };
      await lockLabelKeys(tx, [
        { ...key, spaceId: read.spaceId },
        { ...key, spaceId: null },
      ]);
      const row = await lockVisible(tx, input);
      if (!connectionActions(row, input.caller, false).includes("rename")) {
        throw forbidden(
          "Only the connection owner or a principal with integrations:configure can rename this connection, the latter only one scoped to this space",
        );
      }
      const [connection] = await tx
        .update(c)
        .set({ label: input.label, updatedAt: new Date() })
        .where(eq(c.id, input.connectionId))
        .returning();
      return connection!;
    })
    .catch((err: unknown) => {
      if (!isUniqueViolation(err)) throw err;
      throw conflict(
        "connection_label_taken",
        `The owner already has a connection of this integration named '${input.label}'`,
      );
    });
}

/** Share the caller's own connection into `spaceId` (`share` action); `added: false` when it already was. */
export async function shareConnection(
  input: ShareInput,
): Promise<{ connection: ConnectionRow; added: boolean }> {
  const { connectionId, spaceId, caller } = input;
  // The target's permissions and gate resolve outside the transaction, on `db`.
  const [read] = await db
    .select({ orgId: c.orgId, integrationId: c.integrationId })
    .from(c)
    .where(visibleTo(input))
    .limit(1);
  if (!read) throw connectionNotFound(connectionId);
  assertBoundTarget(caller, spaceId);
  const permissions = await caller.permissionsIn(spaceId, read.orgId);
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
    await assertConnectionShareable(tx, connectionId, spaceId);
    const row = await lockVisible(tx, input);
    if (!connectionActions(row, caller, false).includes("share")) {
      throw forbidden("Only the connection owner can share it");
    }
    const [existing] = await tx
      .select({ spaceId: shares.spaceId })
      .from(shares)
      .where(shareRow(connectionId, spaceId));
    if (existing) return { connection: row, added: false };
    if (refusal) throw refusal;
    // The gate proved the space is of the row's org: the row serves it unless scoped elsewhere.
    if (row.spaceId !== null && row.spaceId !== spaceId) {
      throw invalidShareTarget(
        `This connection cannot serve space '${spaceId}': it is confined to its own space`,
      );
    }
    await tx.insert(shares).values({ connectionId, spaceId, orgId: row.orgId });
    return { connection: await touch(tx, connectionId), added: true };
  });
}

/**
 * Withdraw a connection from `spaceId` — the owner (`share` action) from any space, a governor
 * (`unshare_here`) from the request space — disabling other actors' schedules there naming it
 * (the caller removes their jobs); `removed: false` when it was not shared there.
 */
export async function unshareConnection(input: ShareInput): Promise<{
  connection: ConnectionRow;
  removed: boolean;
  disabledScheduleIds: string[];
}> {
  const { connectionId, spaceId, caller } = input;
  return db.transaction(async (tx) => {
    const row = await lockVisible(tx, input);
    const [existing] = await tx
      .select({ spaceId: shares.spaceId })
      .from(shares)
      .where(shareRow(connectionId, spaceId));
    // The owner (`share`) withdraws from anywhere, a governor (`unshare_here`) from here only.
    const here = spaceId === caller.spaceId;
    // Judged as if shared here, so a withdrawal already done stays an idempotent no-op.
    const actions = connectionActions(row, caller, here);
    if (!actions.includes("share") && !(here && actions.includes("unshare_here"))) {
      throw forbidden(
        "Only the connection owner, or a governor of this space withdrawing it from here, can withdraw it",
      );
    }
    assertBoundTarget(caller, spaceId);
    if (!existing) return { connection: row, removed: false, disabledScheduleIds: [] };
    await assertConnectionsUnpinned(
      tx,
      [connectionId],
      `Connection cannot be unshared from space '${spaceId}'`,
      spaceId,
    );
    await tx.delete(shares).where(shareRow(connectionId, spaceId));
    const connection = await touch(tx, connectionId);
    const owner = actorFromIds(connection.userId, connection.endUserId)!;
    const disabledScheduleIds = await disableForeignSchedules(
      tx,
      [{ id: connectionId, owner, inSpaceId: spaceId }],
      "connection_unshared",
    );
    return { connection, removed: true, disabledScheduleIds };
  });
}

/** A space by id and name, as the share targets name it. */
interface NamedSpace {
  id: string;
  name: string;
}

/**
 * Per row the caller may share (`share` action), the spaces it may be shared into: those the
 * caller sees holding `integrations:connect` (a credential bound to a space: that one only) that
 * the row reaches and that do not block its integration's personal connections, unless the caller
 * also configures them there. One listing and one query per org, never one per row or space.
 */
export async function shareableSpaces(
  caller: ConnectionCaller,
  rows: readonly Pick<ConnectionRow, "id" | "orgId" | "userId" | "endUserId" | "spaceId">[],
  orgRoles: ReadonlyMap<string, OrgRole>,
): Promise<Map<string, NamedSpace[]>> {
  const out = new Map<string, NamedSpace[]>();
  const byOrg = new Map<string, string[]>();
  for (const row of rows) {
    if (!connectionActions(row, caller, false).includes("share")) continue;
    byOrg.set(row.orgId, [...(byOrg.get(row.orgId) ?? []), row.id]);
  }
  const bound = boundSpaceOf(caller.principal);
  await Promise.all(
    [...byOrg].map(async ([orgId, ids]) => {
      const orgRole = orgRoles.get(orgId);
      if (!orgRole) return;
      const targets = (await caller.spacesSeen(orgId, orgRole)).filter(
        (space) =>
          (bound === null || space.id === bound) && space.permissions.has("integrations:connect"),
      );
      if (targets.length === 0) return;
      const names = new Map(targets.map((space) => [space.id, space.name]));
      const found = await db
        .select({
          id: c.id,
          spaceIds: shareableIn({
            spaceIds: targets.map((space) => space.id),
            configures: new Set(
              targets
                .filter((space) => space.permissions.has("integrations:configure"))
                .map((space) => space.id),
            ),
          }),
        })
        .from(c)
        .where(inArray(c.id, ids));
      for (const row of found) {
        out.set(
          row.id,
          row.spaceIds.map((id) => ({ id, name: names.get(id)! })),
        );
      }
    }),
  );
  return out;
}

/**
 * One `integration.connection.share_removed` per withdrawn share, recorded in its space; with no
 * request (`ctx` null, the background sweeper) the actor is `system`.
 */
export async function recordSharesRemoved(
  ctx: Context<AppEnv> | null,
  orgId: string,
  removed: readonly ConnectionShare[],
  reason: "access_lost" | "space_deleted",
): Promise<void> {
  for (const share of removed) {
    const event = {
      action: "integration.connection.share_removed",
      resourceType: "integration_connection",
      resourceId: share.connectionId,
      after: { spaceId: share.spaceId, reason },
    };
    if (ctx) {
      await recordAuditFromContext(ctx, {
        ...event,
        orgIdOverride: orgId,
        spaceIdOverride: share.spaceId,
      });
    } else {
      await recordAudit({ ...event, orgId, spaceId: share.spaceId, actorType: "system" });
    }
  }
}
