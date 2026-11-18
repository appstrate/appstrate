// SPDX-License-Identifier: Apache-2.0

import { and, eq, inArray, isNull, count, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { notifications, runs, runReads, organizationMembers, packages } from "@appstrate/db/schema";
import { scopedWhere, type DbOrTx, type Tx } from "../../lib/db-helpers.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import type { RunStatus } from "@appstrate/core/run-status";
import { actorMatch, type Actor } from "../../lib/actor.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import type { SpaceGrant } from "../../lib/permissions.ts";
import { runReadCondition } from "../../lib/run-visibility.ts";
import { notifyRunFinished } from "./notifications.ts";

// --- Run read state ---
//
// Per recipient, in `run_reads`: a finished run is unread for its recipient
// until they open it. Every reader goes through `unreadRunCondition` (a run's
// `unread`, an agent's and a schedule's `unread_count`, `?unread=true`); every
// writer is below. Reading a run also reads its failure notice, when the bell
// had one: opening the run is how a failure is
// acknowledged, wherever it was seen.

/** Match the caller's own `run_reads` rows by their recipient tuple. */
function recipientFilter(actor: Actor): SQL {
  return actorMatch(actor, { typeCol: runReads.recipientType, idCol: runReads.recipientId });
}

/**
 * Who a run is for — the recipients of its read state and of every notification
 * about it (`notifyRunFinished`, and the agent's own `notify` tool,
 * `createAgentMessageNotifications`). `null` when the run does not exist in
 * `scope`, otherwise the run and its recipients, possibly none:
 *  - the member or end-user who launched it;
 *  - an actor-less run (owner-less org / system schedule) → the org's owners
 *    and admins. An actor-less run is readable only with `runs:read-all` (RBAC
 *    spec §3.4), which is why those are its recipients, and it bounds the row
 *    count.
 *
 * `run.ephemeral` is `packages.ephemeral` (chat, playground, direct inline
 * call); a null join (shadow package already gone) is not ephemeral. The
 * recipients are the same either way: what an ephemeral run skips is the
 * automatic fan-out (`recordRunFinished`), not a message its agent chose to
 * send.
 *
 * Bounded race: a member removed between this read and the insert gets a row
 * they can no longer see (org context refuses a non-member), reaped with the
 * org. Re-validating at insert time would narrow the window, not close it.
 */
export async function resolveRunRecipients(
  scope: SpaceScope,
  runId: string,
  executor: DbOrTx = db,
): Promise<{
  run: {
    id: string;
    packageId: string | null;
    agentName: string | null;
    status: RunStatus;
    ephemeral: boolean;
  };
  recipients: Actor[];
} | null> {
  const [row] = await executor
    .select({
      userId: runs.userId,
      endUserId: runs.endUserId,
      packageId: runs.packageId,
      agentName: runs.agentName,
      status: runs.status,
      packageEphemeral: packages.ephemeral,
    })
    .from(runs)
    .leftJoin(packages, eq(packages.id, runs.packageId))
    .where(
      scopedWhere(runs, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [eq(runs.id, runId)],
      }),
    )
    .limit(1);
  if (!row) return null;
  const run = {
    id: runId,
    packageId: row.packageId,
    agentName: row.agentName,
    status: row.status,
    ephemeral: row.packageEphemeral === true,
  };
  if (row.userId) return { run, recipients: [{ type: "user", id: row.userId }] };
  if (row.endUserId) return { run, recipients: [{ type: "end_user", id: row.endUserId }] };
  const admins = await executor
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, scope.orgId),
        inArray(organizationMembers.role, ["owner", "admin"]),
      ),
    );
  return { run, recipients: admins.map((m) => ({ type: "user", id: m.userId })) };
}

/**
 * Record a freshly finished run: unread for each recipient, and notified when
 * the run needs attention (`notifyRunFinished` decides). Every writer of a
 * terminal run calls it on the transaction that writes the terminal status
 * (`finalizeRun`, `createFailedRun`): a client that sees the run finished finds
 * its read state, so opening it marks it read. The primary key makes a re-fire
 * a no-op.
 *
 * An ephemeral run records nothing: its result is already in front of the
 * caller, so it is neither unread nor announced.
 *
 * Best-effort: it runs in a transaction of its own (a savepoint inside the
 * caller's), and a failure is logged, never thrown — it costs a missing unread
 * dot and bell entry, never the run's terminal status.
 */
export async function recordRunFinished(
  scope: SpaceScope,
  runId: string,
  executor: DbOrTx = db,
): Promise<void> {
  await executor
    .transaction((tx) => writeRunFinished(scope, runId, tx))
    .catch((err) => {
      logger.error("run read-state fan-out failed", { runId, err: getErrorMessage(err) });
    });
}

async function writeRunFinished(scope: SpaceScope, runId: string, executor: Tx): Promise<void> {
  const target = await resolveRunRecipients(scope, runId, executor);
  if (!target || target.run.ephemeral || target.recipients.length === 0) return;
  await executor
    .insert(runReads)
    .values(
      target.recipients.map((r) => ({
        runId,
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        recipientType: r.type,
        recipientId: r.id,
      })),
    )
    .onConflictDoNothing();
  await notifyRunFinished(scope, target.run, target.recipients, executor);
}

/**
 * Correlated predicate over `runs`: the run is unread by `actor`. The
 * recipient is matched on the polymorphic `(type, id)` tuple, so a dashboard
 * user and an end-user never see each other's read state. A read with no actor
 * (system, sidecar) is constant `false`: read state belongs to a recipient.
 */
export function unreadRunCondition(actor: Actor | null): SQL<boolean> {
  if (!actor) return sql<boolean>`false`;
  return sql<boolean>`exists (
    select 1 from ${runReads}
    where ${runReads.runId} = ${runs.id}
      and ${recipientFilter(actor)}
      and ${runReads.readAt} is null
  )`;
}

/** Both updates see one snapshot, including when a concurrent finalization creates a new run and notice. */
async function acknowledgeRuns(scope: SpaceScope, actor: Actor, runId?: string): Promise<number> {
  const reads = db.$with("read_runs").as(
    db
      .update(runReads)
      .set({ readAt: sql`now()` })
      .where(
        scopedWhere(runReads, {
          ...scope,
          extra: [
            recipientFilter(actor),
            isNull(runReads.readAt),
            ...(runId ? [eq(runReads.runId, runId)] : []),
          ],
        }),
      )
      .returning({ runId: runReads.runId }),
  );
  const notices = db.$with("read_notices").as(
    db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(
        scopedWhere(notifications, {
          ...scope,
          extra: [
            actorMatch(actor, {
              typeCol: notifications.recipientType,
              idCol: notifications.recipientId,
            }),
            eq(notifications.type, "run_failed"),
            isNull(notifications.readAt),
            ...(runId ? [eq(notifications.runId, runId)] : []),
          ],
        }),
      ),
  );
  const [row] = await db.with(reads, notices).select({ count: count() }).from(reads);
  return row!.count;
}

export async function markRunRead(scope: SpaceScope, runId: string, actor: Actor): Promise<void> {
  await acknowledgeRuns(scope, actor, runId);
}

/** The number of previously unread runs in this space for this actor. */
export function markAllRunsRead(scope: SpaceScope, actor: Actor): Promise<number> {
  return acknowledgeRuns(scope, actor);
}

/** Fold `(packageId, count)` rows into a map; a row with no package is dropped. */
export function countsByPackage(
  rows: readonly { packageId: string | null; count: number }[],
): Map<string, number> {
  return new Map(
    rows.flatMap(({ packageId, count: value }) => (packageId ? [[packageId, value]] : [])),
  );
}

/**
 * Unread runs per agent for the caller across the spaces of `grants`, in one
 * statement — the agent index's `unread_count`. Each space counts the runs its
 * own grant reads (`runReadCondition`), so the count spans the runs
 * `GET /api/runs?unread=true` lists there, never one the caller can no longer
 * open.
 */
export async function getUnreadRunCountsByAgent(
  orgId: string,
  grants: readonly SpaceGrant[],
  actor: Actor,
): Promise<Map<string, number>> {
  if (grants.length === 0) return new Map();
  const rows = await db
    .select({ packageId: runs.packageId, count: count() })
    .from(runReads)
    .innerJoin(runs, eq(runs.id, runReads.runId))
    .where(
      and(
        eq(runReads.orgId, orgId),
        // Implied by `runReadCondition`, stated on `run_reads` for `idx_run_reads_unread`.
        inArray(
          runReads.spaceId,
          grants.map((g) => g.spaceId),
        ),
        recipientFilter(actor),
        isNull(runReads.readAt),
        runReadCondition(grants, actor),
      ),
    )
    .groupBy(runs.packageId);
  return countsByPackage(rows);
}
