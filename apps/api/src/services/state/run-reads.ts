// SPDX-License-Identifier: Apache-2.0

import { and, eq, inArray, isNull, count, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, runReads, organizationMembers, packages } from "@appstrate/db/schema";
import { scopedWhere } from "../../lib/db-helpers.ts";
import { actorMatch, type Actor } from "../../lib/actor.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import { markRunNotificationsRead, notifyRunFinished } from "./notifications.ts";

// --- Run read state ---
//
// Per recipient, in `run_reads`: a finished run is unread for its recipient
// until they open it. Every reader goes through `unreadRunCondition` (a run's
// `unread`, an agent's and a schedule's `unread_count`, `?unread=true`); every
// writer is below. Reading a run also reads its notification, when the bell
// had one (`markRunNotificationsRead`): opening the run is how a failure is
// acknowledged, wherever it was seen.

/** Match the caller's own `run_reads` rows by their recipient tuple. */
function recipientFilter(actor: Actor): SQL {
  return actorMatch(actor, { typeCol: runReads.recipientType, idCol: runReads.recipientId });
}

/**
 * Who a finished run is for: the member or end-user who launched it, or — an
 * actor-less run (owner-less org / system schedule) — the org's owners and
 * admins. An actor-less run is readable only with `runs:read-all` (RBAC spec
 * §3.4), which is why those are its recipients, and it bounds the row count.
 *
 * Bounded race: a member removed between this read and the insert gets a row
 * they can no longer see (org context refuses a non-member), reaped with the
 * org. Re-validating at insert time would narrow the window, not close it.
 */
async function runRecipients(
  scope: SpaceScope,
  run: { userId: string | null; endUserId: string | null },
): Promise<Actor[]> {
  if (run.userId) return [{ type: "user", id: run.userId }];
  if (run.endUserId) return [{ type: "end_user", id: run.endUserId }];
  const admins = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, scope.orgId),
        inArray(organizationMembers.role, ["owner", "admin"]),
      ),
    );
  return admins.map((m) => ({ type: "user", id: m.userId }));
}

/**
 * Record a freshly finished run: unread for each recipient, and notified when
 * the run needs attention (`notifyRunFinished` decides). Called exactly once
 * per run from the `finalizeRun` CAS winner; the primary key makes a re-fire a
 * no-op anyway.
 *
 * An ephemeral run (chat, playground, direct inline call) records nothing: its
 * result is already in front of the caller. Keyed on `packages.ephemeral`; a
 * null join (shadow package already gone) records it.
 *
 * Best-effort by contract: the caller wraps it — the run is already terminal.
 */
export async function recordRunFinished(scope: SpaceScope, runId: string): Promise<void> {
  const [run] = await db
    .select({
      userId: runs.userId,
      endUserId: runs.endUserId,
      packageId: runs.packageId,
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
  if (!run || run.packageEphemeral === true) return;

  const recipients = await runRecipients(scope, run);
  if (recipients.length === 0) return;
  await db
    .insert(runReads)
    .values(
      recipients.map((r) => ({
        runId,
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        recipientType: r.type,
        recipientId: r.id,
      })),
    )
    .onConflictDoNothing();
  await notifyRunFinished(
    scope,
    { id: runId, packageId: run.packageId, status: run.status },
    recipients,
  );
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

/**
 * Mark a run read for the caller, and its notification with it. Idempotent
 * ack: a missing run or one the caller holds no read state for is a no-op.
 */
export async function markRunRead(scope: SpaceScope, runId: string, actor: Actor): Promise<void> {
  await db
    .update(runReads)
    .set({ readAt: sql`now()` })
    .where(
      scopedWhere(runReads, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [eq(runReads.runId, runId), recipientFilter(actor), isNull(runReads.readAt)],
      }),
    );
  await markRunNotificationsRead(scope, actor, runId);
}

/** Mark every run of the space read for the caller; returns how many were unread. */
export async function markAllRunsRead(scope: SpaceScope, actor: Actor): Promise<number> {
  const updated = await db
    .update(runReads)
    .set({ readAt: sql`now()` })
    .where(
      scopedWhere(runReads, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [recipientFilter(actor), isNull(runReads.readAt)],
      }),
    )
    .returning({ runId: runReads.runId });
  await markRunNotificationsRead(scope, actor);
  return updated.length;
}

/**
 * Unread runs per agent for the caller — the agent index's `unread_count`.
 * `visibility` is the caller's run-read predicate (`runVisibilityFilter`), so
 * the count spans the runs `GET /api/runs?unread=true` lists, never one the
 * caller can no longer open.
 */
export async function getUnreadRunCountsByAgent(
  scope: SpaceScope,
  actor: Actor,
  visibility?: SQL,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ packageId: runs.packageId, count: count() })
    .from(runReads)
    .innerJoin(runs, eq(runs.id, runReads.runId))
    .where(
      scopedWhere(runReads, {
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        extra: [
          recipientFilter(actor),
          isNull(runReads.readAt),
          ...(visibility ? [visibility] : []),
        ],
      }),
    )
    .groupBy(runs.packageId);

  const result: Record<string, number> = {};
  for (const row of rows) {
    if (row.packageId) result[row.packageId] = row.count;
  }
  return result;
}
