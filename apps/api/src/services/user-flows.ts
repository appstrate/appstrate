import { eq, and, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { packages } from "@appstrate/db/schema";
import type { Package } from "@appstrate/db/schema";
import type { Manifest } from "@appstrate/core/validation";

export async function getPackageById(id: string): Promise<Package | null> {
  const rows = await db.select().from(packages).where(eq(packages.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function insertPackage(
  id: string,
  orgId: string,
  type: "flow" | "skill" | "extension",
  manifest: Manifest,
  content: string,
  opts?: {
    source?: "built-in" | "local";
    name?: string;
  },
): Promise<Package> {
  const now = new Date();
  const name = opts?.name ?? manifest.name ?? id;

  const [row] = await db
    .insert(packages)
    .values({
      id,
      orgId,
      type,
      source: opts?.source ?? "local",
      name,
      manifest,
      content,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("Failed to insert package: no row returned");
  return row;
}

export async function updatePackage(
  id: string,
  payload: {
    manifest: Record<string, unknown>;
    content: string;
  },
  expectedVersion: number,
): Promise<Package | null> {
  const rows = await db
    .update(packages)
    .set({
      manifest: payload.manifest,
      content: payload.content,
      updatedAt: new Date(),
      version: sql`${packages.version} + 1`,
    })
    .where(and(eq(packages.id, id), eq(packages.version, expectedVersion)))
    .returning();

  return rows[0] ?? null;
}

export async function deletePackage(id: string): Promise<void> {
  // All related rows cascade-deleted or set-null via FK constraints
  await db.delete(packages).where(eq(packages.id, id));
}
