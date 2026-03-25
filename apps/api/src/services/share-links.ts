import crypto from "node:crypto";
import { eq, and, gt, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { shareLinks, shareLinkUsages } from "@appstrate/db/schema";
import type { Actor } from "../lib/actor.ts";
import { asRecordOrNull } from "../lib/safe-json.ts";
import type { InferSelectModel } from "drizzle-orm";

const DEFAULT_EXPIRES_DAYS = 7;

export type ShareLink = InferSelectModel<typeof shareLinks>;
export type ShareLinkUsage = InferSelectModel<typeof shareLinkUsages>;

// --- Core functions (adapted from share-tokens) ---

export async function createShareLink(
  packageId: string,
  actor: Actor,
  orgId: string,
  options: {
    expiresInDays?: number;
    manifest?: Record<string, unknown>;
    label?: string;
    maxUses?: number | null;
  } = {},
) {
  const { expiresInDays = DEFAULT_EXPIRES_DAYS, manifest, label, maxUses = 1 } = options;
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const ownerFields =
    actor.type === "end_user"
      ? { createdBy: null, endUserId: actor.id }
      : { createdBy: actor.id, endUserId: null };

  const [row] = await db
    .insert(shareLinks)
    .values({
      token,
      packageId,
      ...ownerFields,
      orgId,
      expiresAt,
      manifest: manifest ?? null,
      label: label ?? null,
      maxUses: maxUses ?? null,
    })
    .returning();

  return row;
}

export async function getShareLink(token: string) {
  const rows = await db.select().from(shareLinks).where(eq(shareLinks.token, token)).limit(1);
  return rows[0] ?? null;
}

/**
 * Atomically use a share link: increment usageCount and insert a usage record.
 * Returns null if the link is inactive, expired, or has reached maxUses.
 */
export async function useShareLink(
  token: string,
  meta?: { ip?: string; userAgent?: string; executionId?: string },
) {
  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(shareLinks)
      .where(
        and(
          eq(shareLinks.token, token),
          eq(shareLinks.isActive, true),
          gt(shareLinks.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (rows.length === 0) return null;

    const row = rows[0]!;

    // Check maxUses (null = unlimited)
    if (row.maxUses !== null && row.usageCount >= row.maxUses) return null;

    // Atomically increment usageCount with a WHERE guard to prevent races
    const updated = await tx
      .update(shareLinks)
      .set({ usageCount: sql`${shareLinks.usageCount} + 1` })
      .where(
        and(
          eq(shareLinks.id, row.id),
          sql`${shareLinks.maxUses} IS NULL OR ${shareLinks.usageCount} < ${shareLinks.maxUses}`,
        ),
      )
      .returning();

    if (updated.length === 0) return null;

    // Record usage
    await tx.insert(shareLinkUsages).values({
      shareLinkId: row.id,
      executionId: meta?.executionId ?? null,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });

    return {
      id: row.id,
      packageId: row.packageId,
      createdBy: row.createdBy,
      orgId: row.orgId,
      manifest: asRecordOrNull(row.manifest),
    };
  });

  return result;
}

// --- CRUD functions ---

export async function listShareLinks(packageId: string, orgId: string) {
  return db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.packageId, packageId), eq(shareLinks.orgId, orgId)))
    .orderBy(shareLinks.createdAt);
}

export async function getShareLinkById(id: string, orgId: string) {
  const rows = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.id, id), eq(shareLinks.orgId, orgId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateShareLink(
  id: string,
  orgId: string,
  updates: {
    label?: string | null;
    maxUses?: number | null;
    isActive?: boolean;
    expiresAt?: Date;
  },
) {
  const set: Record<string, unknown> = {};
  if (updates.label !== undefined) set.label = updates.label;
  if (updates.maxUses !== undefined) set.maxUses = updates.maxUses;
  if (updates.isActive !== undefined) set.isActive = updates.isActive;
  if (updates.expiresAt !== undefined) set.expiresAt = updates.expiresAt;

  if (Object.keys(set).length === 0) return null;

  const [row] = await db
    .update(shareLinks)
    .set(set)
    .where(and(eq(shareLinks.id, id), eq(shareLinks.orgId, orgId)))
    .returning();

  return row ?? null;
}

export async function deleteShareLink(id: string, orgId: string) {
  const result = await db
    .delete(shareLinks)
    .where(and(eq(shareLinks.id, id), eq(shareLinks.orgId, orgId)))
    .returning({ id: shareLinks.id });
  return result.length > 0;
}

export async function listShareLinkUsages(shareLinkId: string, limit = 50, offset = 0) {
  return db
    .select()
    .from(shareLinkUsages)
    .where(eq(shareLinkUsages.shareLinkId, shareLinkId))
    .orderBy(shareLinkUsages.usedAt)
    .limit(limit)
    .offset(offset);
}
