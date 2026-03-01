import { eq, desc, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { packageVersions } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { uploadPackageZip } from "./package-storage.ts";

interface PackageVersionEntry {
  id: number;
  packageId: string;
  versionNumber: number;
  createdBy: string | null;
  createdAt: string | null;
}

/** Create a new version snapshot for a package. Returns the version row ID and number. */
export async function createPackageVersion(
  packageId: string,
  createdBy: string,
): Promise<{ id: number; versionNumber: number } | null> {
  try {
    const result = await db.transaction(async (tx) => {
      // Get max version number
      const [maxRow] = await tx
        .select({
          maxVersion: sql<number>`COALESCE(MAX(${packageVersions.versionNumber}), 0)`,
        })
        .from(packageVersions)
        .where(eq(packageVersions.packageId, packageId));

      const nextVersion = (maxRow?.maxVersion ?? 0) + 1;

      const [row] = await tx
        .insert(packageVersions)
        .values({
          packageId,
          versionNumber: nextVersion,
          createdBy,
        })
        .returning({ id: packageVersions.id, versionNumber: packageVersions.versionNumber });

      return { id: row!.id, versionNumber: row!.versionNumber };
    });

    return result;
  } catch (err) {
    logger.error("Failed to create package version", {
      packageId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** List all versions for a package, newest first. */
export async function listPackageVersions(packageId: string): Promise<PackageVersionEntry[]> {
  try {
    const rows = await db
      .select()
      .from(packageVersions)
      .where(eq(packageVersions.packageId, packageId))
      .orderBy(desc(packageVersions.versionNumber));

    return rows.map((r) => ({
      id: r.id,
      packageId: r.packageId,
      versionNumber: r.versionNumber,
      createdBy: r.createdBy,
      createdAt: r.createdAt?.toISOString() ?? null,
    }));
  } catch (err) {
    logger.error("Failed to list package versions", {
      packageId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Get the latest version ID for a package (used to tag executions). */
export async function getLatestVersionId(packageId: string): Promise<number | null> {
  const rows = await db
    .select({ id: packageVersions.id })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId))
    .orderBy(desc(packageVersions.versionNumber))
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * Create a version snapshot and upload the ZIP to Storage in one call.
 * Non-blocking: logs errors but never throws.
 */
export async function createVersionAndUpload(
  packageId: string,
  createdBy: string,
  zipBuffer: Buffer,
): Promise<void> {
  const result = await createPackageVersion(packageId, createdBy);
  if (result !== null) {
    await uploadPackageZip(packageId, result.versionNumber, zipBuffer);
  }
}
