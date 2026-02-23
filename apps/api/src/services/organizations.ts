import { db } from "../lib/db.ts";
import {
  organizations,
  organizationMembers,
  profiles,
  user,
  executions,
  executionLogs,
  shareTokens,
  flowAdminConnections,
  flowSchedules,
  flowConfigs,
  flows,
  serviceConnections,
} from "@appstrate/db/schema";
import { eq, and, inArray, count } from "drizzle-orm";
import type { OrgRole } from "../types/index.ts";

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface OrgMemberRow {
  org_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

function toOrgRow(row: typeof organizations.$inferSelect): OrgRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    created_by: row.createdBy ?? "",
    created_at: row.createdAt?.toISOString() ?? "",
    updated_at: row.updatedAt?.toISOString() ?? "",
  };
}

function toOrgMemberRow(row: typeof organizationMembers.$inferSelect): OrgMemberRow {
  return {
    org_id: row.orgId,
    user_id: row.userId,
    role: row.role,
    joined_at: row.joinedAt?.toISOString() ?? "",
  };
}

export async function createOrganization(
  name: string,
  slug: string,
  userId: string,
): Promise<OrgRow> {
  const [org] = await db
    .insert(organizations)
    .values({ name, slug, createdBy: userId })
    .returning();

  if (!org) throw new Error("Failed to create organization");

  // Add creator as owner
  await db.insert(organizationMembers).values({
    orgId: org.id,
    userId,
    role: "owner",
  });

  return toOrgRow(org);
}

export async function getUserOrganizations(
  userId: string,
): Promise<(OrgRow & { role: OrgRole })[]> {
  const rows = await db
    .select({
      org: organizations,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.orgId, organizations.id))
    .where(eq(organizationMembers.userId, userId));

  return rows.map((row) => ({
    ...toOrgRow(row.org),
    role: row.role as OrgRole,
  }));
}

export async function getOrgById(orgId: string): Promise<OrgRow | null> {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);

  return row ? toOrgRow(row) : null;
}

export async function updateOrganization(
  orgId: string,
  updates: { name?: string; slug?: string },
): Promise<OrgRow | null> {
  const [row] = await db
    .update(organizations)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(organizations.id, orgId))
    .returning();

  if (!row) throw new Error("Failed to update organization");
  return toOrgRow(row);
}

export async function getOrgMembers(
  orgId: string,
): Promise<(OrgMemberRow & { display_name?: string })[]> {
  const rows = await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId))
    .orderBy(organizationMembers.joinedAt);

  const members = rows.map(toOrgMemberRow);
  if (members.length === 0) return [];

  // Fetch display names from profiles
  const userIds = members.map((m) => m.user_id);
  const profileRows = await db
    .select({ id: profiles.id, displayName: profiles.displayName })
    .from(profiles)
    .where(inArray(profiles.id, userIds));

  const profileMap = new Map(profileRows.map((p) => [p.id, p.displayName]));

  return members.map((row) => ({
    ...row,
    display_name: profileMap.get(row.user_id) ?? undefined,
  }));
}

export async function getOrgMember(orgId: string, userId: string): Promise<OrgMemberRow | null> {
  const [row] = await db
    .select()
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .limit(1);

  return row ? toOrgMemberRow(row) : null;
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("duplicate key") || message.includes("unique constraint")) {
      throw new Error("Cet utilisateur est deja membre de cette organisation", { cause: err });
    }
    throw new Error(`Failed to add member: ${message}`, { cause: err });
  }
}

export async function removeMember(orgId: string, userId: string): Promise<void> {
  const deleted = await db
    .delete(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
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
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    .returning({ orgId: organizationMembers.orgId });

  if (updated.length === 0) {
    throw new Error("Failed to update member role: member not found");
  }
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export async function deleteOrganization(orgId: string): Promise<void> {
  // Check for running executions
  const runningResult = await db
    .select({ runningCount: count() })
    .from(executions)
    .where(and(eq(executions.orgId, orgId), inArray(executions.status, ["pending", "running"])));

  if ((runningResult[0]?.runningCount ?? 0) > 0) {
    throw new Error("Impossible de supprimer l'organisation : des executions sont en cours");
  }

  // Delete in FK-safe order within a transaction
  await db.transaction(async (tx) => {
    // execution_logs → executions (cascade exists, but org_id FK needs manual delete)
    await tx.delete(executionLogs).where(eq(executionLogs.orgId, orgId));
    await tx.delete(executions).where(eq(executions.orgId, orgId));
    await tx.delete(shareTokens).where(eq(shareTokens.orgId, orgId));
    await tx.delete(flowAdminConnections).where(eq(flowAdminConnections.orgId, orgId));
    // schedule_runs cascades from flow_schedules
    await tx.delete(flowSchedules).where(eq(flowSchedules.orgId, orgId));
    await tx.delete(flowConfigs).where(eq(flowConfigs.orgId, orgId));
    await tx.delete(flows).where(eq(flows.orgId, orgId));
    // serviceConnections has onDelete cascade from org, but explicit is safer in a tx
    await tx.delete(serviceConnections).where(eq(serviceConnections.orgId, orgId));
    // organization_members cascades from organizations (onDelete: "cascade")

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
