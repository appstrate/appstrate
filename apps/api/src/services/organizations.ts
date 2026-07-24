// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import { CURRENT_API_VERSION } from "../lib/api-versions.ts";
import { toISORequired } from "../lib/date-helpers.ts";
import {
  organizations,
  organizationMembers,
  profiles,
  user,
  runs,
  runLogs,
  packages,
  orgInvitations,
  notifications,
  schedules,
  documents,
  uploads,
} from "@appstrate/db/schema";
import { and, eq, inArray, count, sql } from "drizzle-orm";
import type { OrgRole } from "../types/index.ts";
import { scopedWhere } from "../lib/db-helpers.ts";
import { orgRunConcurrencyLockKey } from "./state/runs.ts";
import { removeScheduleJobs } from "./scheduler.ts";
import { enqueueStorageDeletion, type StorageDeletionJobInput } from "./storage-deletion.ts";
import {
  RUN_WORKSPACE_BUCKET,
  runWorkspaceBundleKey,
  runWorkspaceManifestKey,
} from "./run-workspace-storage.ts";

/** Accepts either the base client or an open transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

interface OrgResult {
  id: string;
  name: string;
  slug: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Running total of durable document bytes stored by this org
   * (`organizations.documents_bytes_used`) — the value the synchronous
   * `ORG_STORAGE_QUOTA_BYTES` gate is checked against. Surfaced so the org
   * settings screen can show consumption against the quota.
   */
  documentsBytesUsed: number;
  /**
   * Per-org durable-document storage limit override in bytes
   * (`organizations.documents_bytes_limit`), or null when no override is set (the
   * org falls back to the global `ORG_STORAGE_QUOTA_BYTES`). Surfaced so the org
   * detail endpoint can report the raw override alongside the effective limit.
   */
  documentsBytesLimit: number | null;
}

function toOrgResult(row: typeof organizations.$inferSelect): OrgResult {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdBy: row.createdBy ?? "",
    createdAt: toISORequired(row.createdAt),
    updatedAt: toISORequired(row.updatedAt),
    documentsBytesUsed: row.documentsBytesUsed,
    documentsBytesLimit: row.documentsBytesLimit,
  };
}

export async function createOrganization(
  name: string,
  slug: string,
  userId: string,
): Promise<OrgResult> {
  // Org + owner-membership are one unit: a partial write (org row created but
  // membership insert failing) would leave an orphan org nobody can access.
  // Wrap both statements in a transaction so they commit or roll back together.
  const org = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(organizations)
      .values({
        name,
        slug,
        createdBy: userId,
        orgSettings: { api_version: CURRENT_API_VERSION },
      })
      .returning();

    if (!created) throw new Error("Failed to create organization");

    // Add creator as owner.
    await tx.insert(organizationMembers).values({
      orgId: created.id,
      userId,
      role: "owner",
    });

    return created;
  });

  return toOrgResult(org);
}

export async function getUserOrganizations(
  userId: string,
  orgIdFilter?: string,
): Promise<(OrgResult & { role: OrgRole })[]> {
  const rows = await db
    .select({
      org: organizations,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.orgId, organizations.id))
    .where(
      orgIdFilter
        ? and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgIdFilter))
        : eq(organizationMembers.userId, userId),
    );

  return rows.map((row) => ({
    ...toOrgResult(row.org),
    role: row.role as OrgRole,
  }));
}

export async function getOrgById(orgId: string): Promise<OrgResult | null> {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);

  return row ? toOrgResult(row) : null;
}

export async function updateOrganization(
  orgId: string,
  updates: { name?: string; slug?: string },
): Promise<OrgResult> {
  const [row] = await db
    .update(organizations)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(organizations.id, orgId))
    .returning();

  if (!row) throw new Error("Failed to update organization");
  return toOrgResult(row);
}

export { orgSettingsSchema } from "@appstrate/core/permissions";
import type { OrgSettings } from "@appstrate/shared-types";
export type { OrgSettings };

export async function getOrgSettings(orgId: string): Promise<OrgSettings> {
  const [row] = await db
    .select({ orgSettings: organizations.orgSettings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return (row?.orgSettings as OrgSettings) ?? {};
}

export async function updateOrgSettings(
  orgId: string,
  updates: Partial<OrgSettings>,
): Promise<OrgSettings> {
  // Merge server-side via JSONB concatenation so concurrent admins toggling
  // different keys don't clobber each other (read-modify-write would race).
  const [row] = await db
    .update(organizations)
    .set({
      orgSettings: sql`COALESCE(${organizations.orgSettings}, '{}'::jsonb) || ${JSON.stringify(updates)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, orgId))
    .returning({ orgSettings: organizations.orgSettings });

  return (row?.orgSettings as OrgSettings) ?? {};
}

export async function getOrgMembers(orgId: string) {
  const rows = await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId))
    .orderBy(organizationMembers.joinedAt);

  if (rows.length === 0) return [];

  // Fetch display names and emails
  const userIds = rows.map((m) => m.userId);
  const [profileRows, userRows] = await Promise.all([
    db
      .select({ id: profiles.id, displayName: profiles.displayName })
      .from(profiles)
      .where(inArray(profiles.id, userIds)),
    db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, userIds)),
  ]);

  const profileMap = new Map(profileRows.map((p) => [p.id, p.displayName]));
  const emailMap = new Map(userRows.map((u) => [u.id, u.email]));

  return rows.map((row) => ({
    ...row,
    displayName: profileMap.get(row.userId) ?? undefined,
    email: emailMap.get(row.userId) ?? undefined,
  }));
}

export async function getOrgMember(orgId: string, userId: string) {
  const [row] = await db
    .select()
    .from(organizationMembers)
    .where(
      scopedWhere(organizationMembers, {
        orgId,
        extra: [eq(organizationMembers.userId, userId)],
      }),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Single-member counterpart to {@link getOrgMembers}: returns one member row
 * enriched with the same `displayName` + `email` fields the list endpoint
 * exposes, so a mutation handler can echo the full member DTO without a
 * follow-up GET. Returns null when the user is not a member of the org.
 */
export async function getOrgMemberWithProfile(orgId: string, userId: string) {
  const member = await getOrgMember(orgId, userId);
  if (!member) return null;

  const [profileRow, userRow] = await Promise.all([
    db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1),
    db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1),
  ]);

  return {
    ...member,
    displayName: profileRow[0]?.displayName ?? undefined,
    email: userRow[0]?.email ?? undefined,
  };
}

export async function addMember(
  orgId: string,
  userId: string,
  role: OrgRole = "member",
  tx: DbOrTx = db,
): Promise<void> {
  // ON CONFLICT DO NOTHING makes this idempotent AND transaction-safe. A plain
  // INSERT that hits the (org_id, user_id) PK would raise — and inside an
  // enclosing transaction a raised statement ABORTS the whole transaction, so
  // a caught-and-swallowed error would still poison the surrounding tx. The
  // conflict clause turns "already a member" into a clean no-op (the existing
  // row, and its role, are left untouched — no silent downgrade).
  await tx.insert(organizationMembers).values({ orgId, userId, role }).onConflictDoNothing();
}

export async function removeMember(orgId: string, userId: string): Promise<void> {
  // One transaction: the member row, the member's notifications, AND the
  // member's schedules in this org are handled atomically. The member's runs
  // stay in the org for history, so their notifications are not cascaded away
  // — and since notifications carry the recipient as a polymorphic
  // (recipientType, recipientId) tuple with NO foreign key, nothing else would
  // clean them up (org/application FK cascades only fire on org/app deletion).
  // Schedules similarly only cascade on user-ACCOUNT or org deletion, and a
  // removed member's user row survives (multi-org) — without the disable here
  // their schedules would keep firing under the revoked identity (CRIT-13).
  // A throw inside rolls everything back.
  const disabledScheduleIds = await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(organizationMembers)
      .where(
        scopedWhere(organizationMembers, {
          orgId,
          extra: [eq(organizationMembers.userId, userId)],
        }),
      )
      .returning({ orgId: organizationMembers.orgId });

    if (deleted.length === 0) {
      throw new Error("Failed to remove member: member not found");
    }

    await tx
      .delete(notifications)
      .where(
        and(
          eq(notifications.orgId, orgId),
          eq(notifications.recipientType, "user"),
          eq(notifications.recipientId, userId),
        ),
      );

    // Disable (not delete — the row is org history) every schedule the
    // removed member owns as its execution actor in THIS org.
    const disabled = await tx
      .update(schedules)
      .set({ enabled: false, nextRunAt: null, updatedAt: new Date() })
      .where(
        and(eq(schedules.orgId, orgId), eq(schedules.userId, userId), eq(schedules.enabled, true)),
      )
      .returning({ id: schedules.id });
    return disabled.map((row) => row.id);
  });

  // Queue removal can't join the DB transaction; run it after commit,
  // best-effort (errors logged inside). The fire-time actor revalidation in
  // the scheduler is the backstop for any repeatable job that survives a
  // crash between the commit and this call.
  await removeScheduleJobs(disabledScheduleIds);
}

export async function updateMemberRole(
  orgId: string,
  userId: string,
  role: OrgRole,
): Promise<void> {
  const updated = await db
    .update(organizationMembers)
    .set({ role })
    .where(
      scopedWhere(organizationMembers, {
        orgId,
        extra: [eq(organizationMembers.userId, userId)],
      }),
    )
    .returning({ orgId: organizationMembers.orgId });

  if (updated.length === 0) {
    throw new Error("Failed to update member role: member not found");
  }
}

export async function deleteOrganization(orgId: string): Promise<void> {
  // Delete in FK-safe order within a transaction. The in-progress-runs check
  // lives INSIDE the transaction (was previously a separate read before it):
  // outside, a run could transition pending/running in the window between the
  // check and the delete (TOCTOU), so we'd cascade-delete a live run's rows.
  // Doing the count in the same transaction as the deletes — which take row
  // locks on the runs being removed — closes that window.
  await db.transaction(async (tx) => {
    // Serialize against concurrent run admission. `createRun` acquires this
    // same per-org advisory lock before its count + INSERT. Taking it here
    // means a run admitted after our snapshot below cannot commit until this
    // transaction finishes — closing the TOCTOU window where a run that
    // started after the count but before the delete would be cascade-deleted
    // mid-flight. Released automatically at transaction end.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${orgRunConcurrencyLockKey(orgId)})::bigint)`,
    );

    // Lock the parent before enumerating cascade-owned children. Concurrent
    // FK inserts then either commit before this snapshot or wait until the
    // organization is gone; no child can disappear without an outbox job.
    const [lockedOrg] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
      .for("update");
    if (!lockedOrg) throw new Error("Failed to delete organization: not found");

    const runningResult = await tx
      .select({ runningCount: count() })
      .from(runs)
      .where(scopedWhere(runs, { orgId, extra: [inArray(runs.status, ["pending", "running"])] }));

    if ((runningResult[0]?.runningCount ?? 0) > 0) {
      throw new Error("Cannot delete organization: runs are in progress");
    }

    // Enumerate every storage object this org owns BEFORE the FK cascade drops
    // the rows, and enqueue its physical deletion into the transactional outbox
    // (same transaction). Without this the cascade would silently orphan the
    // org's documents / uploads / run-workspace objects in S3/FS. The worker
    // expands each run manifest into its document keys and deletes the manifest
    // last, so this transaction does no storage I/O and cleanup remains
    // replayable. (Queries are sequential — a Drizzle tx multiplexes one
    // connection, so concurrent queries on `tx` are unsafe.)
    const docRows = await tx
      .select({ storageKey: documents.storageKey })
      .from(documents)
      .where(eq(documents.orgId, orgId));
    const uploadRows = await tx
      .select({ storageKey: uploads.storageKey })
      .from(uploads)
      .where(eq(uploads.orgId, orgId));
    const runRows = await tx.select({ id: runs.id }).from(runs).where(eq(runs.orgId, orgId));

    const storageJobs: StorageDeletionJobInput[] = [];
    for (const r of [...docRows, ...uploadRows]) {
      const [bucket, ...rest] = r.storageKey.split("/");
      if (bucket && rest.length > 0)
        storageJobs.push({ bucket, storageKey: rest.join("/"), reason: "org_deleted" });
    }
    for (const r of runRows) {
      storageJobs.push({
        bucket: RUN_WORKSPACE_BUCKET,
        storageKey: runWorkspaceBundleKey(r.id),
        reason: "org_deleted",
      });
      storageJobs.push({
        bucket: RUN_WORKSPACE_BUCKET,
        storageKey: runWorkspaceManifestKey(r.id),
        reason: "org_deleted",
      });
    }
    await enqueueStorageDeletion(tx, storageJobs);

    // run_logs → runs (cascade exists, but org_id FK needs manual delete)
    await tx.delete(runLogs).where(eq(runLogs.orgId, orgId));
    await tx.delete(runs).where(eq(runs.orgId, orgId));
    // Org-scoped tables (package_schedules, org_models, model_provider_credentials,
    // and module-owned tables like webhooks) cascade via their orgId FK —
    // no explicit delete needed.
    // applicationPackages cascade through applications → orgId
    await tx.delete(packages).where(eq(packages.orgId, orgId));
    // integration_connections cascade through applications → orgId — no explicit delete needed
    await tx.delete(orgInvitations).where(eq(orgInvitations.orgId, orgId));
    // org_members cascades from organizations (onDelete: "cascade")

    const deleted = await tx
      .delete(organizations)
      .where(eq(organizations.id, orgId))
      .returning({ id: organizations.id });
    if (deleted.length === 0) {
      throw new Error("Failed to delete organization: not found");
    }
  });
}

export async function isSlugAvailable(slug: string): Promise<boolean> {
  const result = await db
    .select({ slugCount: count() })
    .from(organizations)
    .where(eq(organizations.slug, slug));

  return (result[0]?.slugCount ?? 0) === 0;
}
