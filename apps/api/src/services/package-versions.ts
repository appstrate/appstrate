import { eq, and, desc } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { packages, packageVersions, packageDistTags } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { uploadPackageZip } from "./package-storage.ts";
import { computeIntegrity } from "@appstrate/core/integrity";
import { extractDependencies } from "@appstrate/core/dependencies";
import { storeVersionDependencies } from "./package-version-deps.ts";
import {
  isValidVersion,
  versionGt,
  resolveVersionFromCatalog,
  type CatalogVersion,
  type DistTagEntry,
} from "@appstrate/core/semver";
import {
  validateForwardVersion,
  findBestStableVersion,
  bumpPatch,
  shouldUpdateLatestTag,
} from "@appstrate/core/version-policy";
import { isValidDistTag, isProtectedTag } from "@appstrate/core/dist-tags";

// ─────────────────────────────────────────────
// Version creation
// ─────────────────────────────────────────────

interface CreateVersionParams {
  packageId: string;
  version: string;
  integrity: string;
  artifactSize: number;
  manifest: Record<string, unknown>;
  orgId: string;
  createdBy: string;
}

/** Create a new version with semver, integrity, manifest snapshot. Auto-manages "latest" dist-tag. */
export async function createPackageVersion(params: CreateVersionParams): Promise<{
  id: number;
  version: string;
} | null> {
  const { packageId, version, integrity, artifactSize, manifest, orgId, createdBy } = params;

  if (!isValidVersion(version)) {
    logger.error("Invalid semver version", { packageId, version });
    return null;
  }

  try {
    return await db.transaction(async (tx) => {
      // Forward-only enforcement (include yanked — duplicates must be rejected even if yanked)
      const allExisting = await tx
        .select({ version: packageVersions.version })
        .from(packageVersions)
        .where(eq(packageVersions.packageId, packageId));

      const existingVersions = allExisting.map((v) => v.version);
      const forwardCheck = validateForwardVersion(version, existingVersions);

      if (!forwardCheck.ok) {
        if (forwardCheck.error === "VERSION_EXISTS") {
          logger.warn("Version already exists", { packageId, version });
          const [existingRow] = await tx
            .select({ id: packageVersions.id, version: packageVersions.version })
            .from(packageVersions)
            .where(
              and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)),
            )
            .limit(1);
          return existingRow ?? null;
        }
        logger.warn("Version not higher", { packageId, version, highest: forwardCheck.highest });
        return null;
      }

      const [row] = await tx
        .insert(packageVersions)
        .values({ packageId, version, integrity, artifactSize, manifest, orgId, createdBy })
        .returning({ id: packageVersions.id, version: packageVersions.version });

      if (!row) {
        logger.error("Insert returned no row", { packageId, version });
        return null;
      }

      // Auto-manage "latest" dist-tag
      const [currentLatest] = await tx
        .select({ version: packageVersions.version })
        .from(packageDistTags)
        .innerJoin(packageVersions, eq(packageDistTags.versionId, packageVersions.id))
        .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, "latest")))
        .limit(1);

      if (shouldUpdateLatestTag(version, currentLatest?.version ?? null)) {
        await tx
          .insert(packageDistTags)
          .values({ packageId, tag: "latest", versionId: row.id })
          .onConflictDoUpdate({
            target: [packageDistTags.packageId, packageDistTags.tag],
            set: { versionId: row.id, updatedAt: new Date() },
          });
      }

      return { id: row.id, version: row.version };
    });
  } catch (err) {
    logger.error("Failed to create package version", {
      packageId,
      version,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─────────────────────────────────────────────
// Version queries
// ─────────────────────────────────────────────

/** List all versions for a package, newest first. */
export async function listPackageVersions(packageId: string) {
  const rows = await db
    .select({
      id: packageVersions.id,
      version: packageVersions.version,
      integrity: packageVersions.integrity,
      artifactSize: packageVersions.artifactSize,
      yanked: packageVersions.yanked,
      createdBy: packageVersions.createdBy,
      createdAt: packageVersions.createdAt,
    })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId))
    .orderBy(desc(packageVersions.createdAt));

  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt?.toISOString() ?? null,
  }));
}

/** Get the latest version ID for a package via "latest" dist-tag, fallback to highest by id. */
export async function getLatestVersionId(packageId: string): Promise<number | null> {
  const [tag] = await db
    .select({ versionId: packageDistTags.versionId })
    .from(packageDistTags)
    .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, "latest")))
    .limit(1);

  if (tag) return tag.versionId;

  const [row] = await db
    .select({ id: packageVersions.id })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId))
    .orderBy(desc(packageVersions.id))
    .limit(1);

  return row?.id ?? null;
}

/** 3-step version resolution: exact → dist-tag → semver range. */
export async function resolveVersion(packageId: string, query: string): Promise<number | null> {
  const allVersions: CatalogVersion[] = await db
    .select({
      id: packageVersions.id,
      version: packageVersions.version,
      yanked: packageVersions.yanked,
    })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId));

  const allDistTags: DistTagEntry[] = await db
    .select({ tag: packageDistTags.tag, versionId: packageDistTags.versionId })
    .from(packageDistTags)
    .where(eq(packageDistTags.packageId, packageId));

  return resolveVersionFromCatalog(query, allVersions, allDistTags);
}

// ─────────────────────────────────────────────
// Yank
// ─────────────────────────────────────────────

/** Yank a version. Reassigns dist-tags pointing to the yanked version. */
export async function yankVersion(
  packageId: string,
  version: string,
  reason?: string,
): Promise<boolean> {
  const [yanked] = await db
    .update(packageVersions)
    .set({ yanked: true, yankedReason: reason ?? null })
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
    .returning({ id: packageVersions.id });

  if (!yanked) return false;

  const affectedTags = await db
    .select({ tag: packageDistTags.tag })
    .from(packageDistTags)
    .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.versionId, yanked.id)));

  if (affectedTags.length > 0) {
    const candidates = await db
      .select({ id: packageVersions.id, version: packageVersions.version })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.yanked, false)));

    const best = findBestStableVersion(candidates);

    for (const { tag } of affectedTags) {
      if (best) {
        await db
          .update(packageDistTags)
          .set({ versionId: best.id, updatedAt: new Date() })
          .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, tag)));
      } else {
        await db
          .delete(packageDistTags)
          .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, tag)));
      }
    }
  }

  return true;
}

// ─────────────────────────────────────────────
// Dist-tags
// ─────────────────────────────────────────────

export async function addDistTag(packageId: string, tag: string, versionId: number): Promise<void> {
  if (!isValidDistTag(tag)) throw new Error(`Invalid tag name '${tag}'`);
  if (isProtectedTag(tag)) throw new Error("The 'latest' tag cannot be set manually");

  await db
    .insert(packageDistTags)
    .values({ packageId, tag, versionId })
    .onConflictDoUpdate({
      target: [packageDistTags.packageId, packageDistTags.tag],
      set: { versionId, updatedAt: new Date() },
    });
}

export async function removeDistTag(packageId: string, tag: string): Promise<void> {
  if (isProtectedTag(tag)) throw new Error("The 'latest' tag cannot be removed");
  await db
    .delete(packageDistTags)
    .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, tag)));
}

export async function listDistTags(packageId: string): Promise<{ tag: string; version: string }[]> {
  return db
    .select({ tag: packageDistTags.tag, version: packageVersions.version })
    .from(packageDistTags)
    .innerJoin(packageVersions, eq(packageDistTags.versionId, packageVersions.id))
    .where(eq(packageDistTags.packageId, packageId));
}

// ─────────────────────────────────────────────
// Auto-version helpers
// ─────────────────────────────────────────────

/** Get the next version for a package. Auto-bumps patch from "latest" or manifest.version. */
export async function getNextVersion(packageId: string): Promise<string> {
  const [pkg] = await db
    .select({ manifest: packages.manifest })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);

  const manifestVersion = (pkg?.manifest as Record<string, unknown> | null)?.version as
    | string
    | undefined;

  const [latestTag] = await db
    .select({ versionId: packageDistTags.versionId })
    .from(packageDistTags)
    .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, "latest")))
    .limit(1);

  if (latestTag) {
    const [latestVer] = await db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.id, latestTag.versionId))
      .limit(1);

    if (latestVer) {
      if (
        manifestVersion &&
        isValidVersion(manifestVersion) &&
        versionGt(manifestVersion, latestVer.version)
      ) {
        return manifestVersion;
      }
      return bumpPatch(latestVer.version) ?? "1.0.0";
    }
  }

  if (manifestVersion && isValidVersion(manifestVersion)) return manifestVersion;
  return "1.0.0";
}

// ─────────────────────────────────────────────
// Convenience: create version + upload ZIP
// ─────────────────────────────────────────────

/** Create a version snapshot and upload the ZIP to Storage in one call. */
export async function createVersionAndUpload(params: {
  packageId: string;
  version: string;
  orgId: string;
  createdBy: string;
  zipBuffer: Buffer;
  manifest: Record<string, unknown>;
}): Promise<{ id: number; version: string } | null> {
  const { packageId, version, orgId, createdBy, zipBuffer, manifest } = params;

  const integrity = computeIntegrity(new Uint8Array(zipBuffer));
  const artifactSize = zipBuffer.byteLength;

  const result = await createPackageVersion({
    packageId,
    version,
    integrity,
    artifactSize,
    manifest,
    orgId,
    createdBy,
  });

  if (result) {
    await uploadPackageZip(packageId, result.version, zipBuffer);

    const deps = extractDependencies(manifest);
    if (deps.length > 0) {
      await storeVersionDependencies(result.id, deps);
    }
  }

  return result;
}
