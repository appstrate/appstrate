import { eq, and } from "drizzle-orm";
import { db } from "../lib/db.ts";
import {
  packages,
  executions,
  packageSchedules,
  packageConfigs,
  packageVersions,
  packageAdminConnections,
} from "@appstrate/db/schema";
import type { Package } from "@appstrate/db/schema";
import type { Manifest } from "@appstrate/validation";

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
  expectedUpdatedAt: string,
): Promise<Package | null> {
  const rows = await db
    .update(packages)
    .set({
      manifest: payload.manifest,
      content: payload.content,
      updatedAt: new Date(),
    })
    .where(and(eq(packages.id, id), eq(packages.updatedAt, new Date(expectedUpdatedAt))))
    .returning();

  return rows[0] ?? null;
}

export async function deletePackage(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    // packageDependencies cascade-deleted via packages FK
    // execution_logs cascade-deleted via executions FK
    await tx.delete(executions).where(eq(executions.packageId, id));
    await tx.delete(packageSchedules).where(eq(packageSchedules.packageId, id));
    await tx.delete(packageConfigs).where(eq(packageConfigs.packageId, id));
    await tx.delete(packageVersions).where(eq(packageVersions.packageId, id));
    await tx.delete(packageAdminConnections).where(eq(packageAdminConnections.packageId, id));
    await tx.delete(packages).where(eq(packages.id, id));
  });
}
