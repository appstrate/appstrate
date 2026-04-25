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
} from "@appstrate/db/schema";
import { and, eq, inArray, count, sql } from "drizzle-orm";
import type { OrgRole } from "../types/index.ts";
import { scopedWhere } from "../lib/db-helpers.ts";

interface OrgResult {
  id: string;
  name: string;
  slug: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function toOrgResult(row: typeof organizations.$inferSelect): OrgResult {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdBy: row.createdBy ?? "",
    createdAt: toISORequired(row.createdAt),
    updatedAt: toISORequired(row.updatedAt),
  };
}

export async function createOrganization(
  name: string,
  slug: string,
  userId: string,
): Promise<OrgResult> {
  const [org] = await db
    .insert(organizations)
    .values({
      name,
      slug,
      createdBy: userId,
      orgSettings: { apiVersion: CURRENT_API_VERSION },
    })
    .returning();

  if (!org) throw new Error("Failed to create organization");

  // Add creator as owner
  await db.insert(organizationMembers).values({
    orgId: org.id,
    userId,
    role: "owner",
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
): Promise<OrgResult | null> {
  const [row] = await db
    .update(organizations)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(organizations.id, orgId))
    .returning();

  if (!row) throw new Error("Failed to update organization");
  return toOrgResult(row);
}

export { orgSettingsSchema } from "@appstrate/shared-types";
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

export async function findUserByEmail(email: string): Promise<{ id: string } | null> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);

  return row ?? null;
}

export async function addMember(
  orgId: string,
  userId: string,
  role: OrgRole = "member",
): Promise<void> {
  try {
    await db.insert(organizationMembers).values({
      orgId,
      userId,
      role,
    });
  } catch (err: unknown) {
    // Drizzle wraps the postgres driver error in `DrizzleQueryError` whose
    // `message` only says "Failed query: …" — the unique-violation details
    // live on `err.cause` (with PG `code === "23505"`). Walk the cause chain
    // so we match both the wrapped and the raw error shape.
    if (isUniqueViolation(err)) {
      // User is already a member — idempotent, silently ignore
      return;
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  // Cap depth to defend against pathological / circular `cause` chains.
  // Drizzle wraps once, postgres.js wraps once — 8 hops is generous.
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 8; depth++) {
    if (typeof cur === "object") {
      const e = cur as { code?: unknown; message?: unknown };
      if (e.code === "23505") return true;
      const msg = typeof e.message === "string" ? e.message : "";
      if (msg.includes("duplicate key") || msg.includes("unique constraint")) return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export async function removeMember(orgId: string, userId: string): Promise<void> {
  const deleted = await db
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
  // Check for running runs
  const runningResult = await db
    .select({ runningCount: count() })
    .from(runs)
    .where(scopedWhere(runs, { orgId, extra: [inArray(runs.status, ["pending", "running"])] }));

  if ((runningResult[0]?.runningCount ?? 0) > 0) {
    throw new Error("Cannot delete organization: runs are in progress");
  }

  // Delete in FK-safe order within a transaction
  await db.transaction(async (tx) => {
    // run_logs → runs (cascade exists, but org_id FK needs manual delete)
    await tx.delete(runLogs).where(eq(runLogs.orgId, orgId));
    await tx.delete(runs).where(eq(runs.orgId, orgId));
    // Org-scoped tables (package_schedules, org_models, org_system_provider_keys,
    // and module-owned tables like webhooks) cascade via their orgId FK —
    // no explicit delete needed.
    // applicationPackages cascade through applications → orgId
    await tx.delete(packages).where(eq(packages.orgId, orgId));
    // userProviderConnections are now profile-scoped (user-owned), not org-scoped — no cleanup needed
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
