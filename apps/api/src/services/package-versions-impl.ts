import { eq, and, desc, count } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { packages, packageVersions, packageDistTags } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import {
  uploadPackageZip,
  downloadVersionZip,
  deleteVersionZip,
  unzipAndNormalize,
} from "./package-storage.ts";
import { computeIntegrity } from "@appstrate/core/integrity";
import { extractDependencies } from "@appstrate/core/dependencies";
import { storeVersionDependencies, clearVersionDependencies } from "./package-version-deps.ts";
import {
  isValidVersion,
  resolveVersionFromCatalog,
  type CatalogVersion,
  type DistTagEntry,
} from "@appstrate/core/semver";
import { planCreateVersionOutcome, planTagReassignment } from "@appstrate/core/version-policy";
import { isValidDistTag, isProtectedTag } from "@appstrate/core/dist-tags";
import { buildRegistryDependencies } from "./package-items/dependencies.ts";
import { prepareManifestForPublish } from "@appstrate/core/publish-manifest";
import { parseScopedName } from "@appstrate/core/naming";

// ─────────────────────────────────────────────
// Version creation
// ─────────────────────────────────────────────

interface CreateVersionParams {
  packageId: string;
  version: string;
  integrity: string;
  artifactSize: number;
  manifest: Record<string, unknown>;
  orgId: string | null;
  createdBy: string | null;
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

      const [currentLatest] = await tx
        .select({ version: packageVersions.version })
        .from(packageDistTags)
        .innerJoin(packageVersions, eq(packageDistTags.versionId, packageVersions.id))
        .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, "latest")))
        .limit(1);

      const outcome = planCreateVersionOutcome(
        version,
        allExisting.map((v) => v.version),
        currentLatest?.version ?? null,
      );

      if (outcome.action === "exists") {
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
      if (outcome.action === "rejected") {
        logger.warn("Version not higher", { packageId, version, highest: outcome.highest });
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
      if (outcome.shouldUpdateLatest) {
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

/** Get the latest version ID + manifest for dirty-check at execution time. */
export async function getLatestVersionWithManifest(
  packageId: string,
): Promise<{ id: number; manifest: Record<string, unknown> } | null> {
  const versionId = await getLatestVersionId(packageId);
  if (!versionId) return null;

  const [row] = await db
    .select({ id: packageVersions.id, manifest: packageVersions.manifest })
    .from(packageVersions)
    .where(eq(packageVersions.id, versionId))
    .limit(1);

  if (!row) return null;
  return { id: row.id, manifest: row.manifest as Record<string, unknown> };
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

/** Get a version row suitable for download (via 3-step resolution). Returns null if not found. */
export async function getVersionForDownload(
  packageId: string,
  versionQuery: string,
): Promise<{
  id: number;
  version: string;
  integrity: string;
  artifactSize: number;
  yanked: boolean;
} | null> {
  const versionId = await resolveVersion(packageId, versionQuery);
  if (!versionId) return null;

  const [row] = await db
    .select({
      id: packageVersions.id,
      version: packageVersions.version,
      integrity: packageVersions.integrity,
      artifactSize: packageVersions.artifactSize,
      yanked: packageVersions.yanked,
    })
    .from(packageVersions)
    .where(eq(packageVersions.id, versionId))
    .limit(1);

  return row ?? null;
}

// ─────────────────────────────────────────────
// Version detail
// ─────────────────────────────────────────────

export interface VersionDetail {
  id: number;
  version: string;
  manifest: Record<string, unknown>;
  textContent: string | null;
  content: Record<string, Uint8Array> | null;
  yanked: boolean;
  yankedReason: string | null;
  integrity: string;
  artifactSize: number;
  createdAt: string | null;
}

/**
 * Resolve a version query and return full version data including text content extracted from ZIP.
 * Returns null if the version cannot be resolved.
 */
export async function getVersionDetail(
  packageId: string,
  versionQuery: string,
): Promise<VersionDetail | null> {
  const versionId = await resolveVersion(packageId, versionQuery);
  if (!versionId) return null;

  const [row] = await db
    .select({
      id: packageVersions.id,
      version: packageVersions.version,
      manifest: packageVersions.manifest,
      integrity: packageVersions.integrity,
      artifactSize: packageVersions.artifactSize,
      yanked: packageVersions.yanked,
      yankedReason: packageVersions.yankedReason,
      createdAt: packageVersions.createdAt,
    })
    .from(packageVersions)
    .where(eq(packageVersions.id, versionId))
    .limit(1);

  if (!row) return null;

  // Try to download and extract ZIP content
  let textContent: string | null = null;
  let content: Record<string, Uint8Array> | null = null;

  try {
    const zipBuffer = await downloadVersionZip(packageId, row.version);
    if (zipBuffer) {
      const files = unzipAndNormalize(zipBuffer);
      content = files;
      // Extract prompt.md from ZIP
      const promptData = files["prompt.md"];
      if (promptData) {
        textContent = new TextDecoder().decode(promptData);
      }
    }
  } catch (err) {
    logger.warn("Failed to extract ZIP for version detail", {
      packageId,
      version: row.version,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    id: row.id,
    version: row.version,
    manifest: row.manifest as Record<string, unknown>,
    textContent,
    content,
    yanked: row.yanked,
    yankedReason: row.yankedReason,
    integrity: row.integrity,
    artifactSize: row.artifactSize,
    createdAt: row.createdAt?.toISOString() ?? null,
  };
}

/** Count the number of published versions for a package. */
export async function getVersionCount(packageId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId));
  return row?.count ?? 0;
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

    const instructions = planTagReassignment(affectedTags, candidates);

    for (const instr of instructions) {
      if (instr.action === "reassign") {
        await db
          .update(packageDistTags)
          .set({ versionId: instr.newVersionId, updatedAt: new Date() })
          .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, instr.tag)));
      } else {
        await db
          .delete(packageDistTags)
          .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, instr.tag)));
      }
    }
  }

  return true;
}

// ─────────────────────────────────────────────
// Delete version
// ─────────────────────────────────────────────

/** Permanently delete a version. Reassigns dist-tags, then removes the DB row and storage artifact. */
export async function deletePackageVersion(packageId: string, version: string): Promise<boolean> {
  // Find the version row
  const [row] = await db
    .select({ id: packageVersions.id })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
    .limit(1);

  if (!row) return false;

  // Reassign dist-tags that point to this version before deleting
  const affectedTags = await db
    .select({ tag: packageDistTags.tag })
    .from(packageDistTags)
    .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.versionId, row.id)));

  if (affectedTags.length > 0) {
    // Candidates = all non-yanked versions EXCEPT the one being deleted
    const candidates = await db
      .select({ id: packageVersions.id, version: packageVersions.version })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.yanked, false)));

    const filteredCandidates = candidates.filter((c) => c.id !== row.id);
    const instructions = planTagReassignment(affectedTags, filteredCandidates);

    for (const instr of instructions) {
      if (instr.action === "reassign") {
        await db
          .update(packageDistTags)
          .set({ versionId: instr.newVersionId, updatedAt: new Date() })
          .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, instr.tag)));
      } else {
        await db
          .delete(packageDistTags)
          .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, instr.tag)));
      }
    }
  }

  // Delete the version row (CASCADE removes packageVersionDependencies)
  await db.delete(packageVersions).where(eq(packageVersions.id, row.id));

  // Best-effort storage cleanup (outside transaction — don't fail if missing)
  await deleteVersionZip(packageId, version);

  logger.info("Deleted package version", { packageId, version });
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

async function listDistTags(packageId: string): Promise<{ tag: string; version: string }[]> {
  return db
    .select({ tag: packageDistTags.tag, version: packageVersions.version })
    .from(packageDistTags)
    .innerJoin(packageVersions, eq(packageDistTags.versionId, packageVersions.id))
    .where(eq(packageDistTags.packageId, packageId));
}

/** Get the dist-tag names that point to a specific version. */
export async function getMatchingDistTags(packageId: string, version: string): Promise<string[]> {
  const distTags = await listDistTags(packageId);
  return distTags.filter((dt) => dt.version === version).map((dt) => dt.tag);
}

/** Return the latest published version and the current draft version from the manifest. */
export async function getVersionInfo(
  packageId: string,
): Promise<{ latestVersion: string | null; draftVersion: string | null }> {
  const [[pkg], [latestTag]] = await Promise.all([
    db
      .select({ manifest: packages.manifest })
      .from(packages)
      .where(eq(packages.id, packageId))
      .limit(1),
    db
      .select({ versionId: packageDistTags.versionId })
      .from(packageDistTags)
      .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, "latest")))
      .limit(1),
  ]);

  const draftVersion =
    ((pkg?.manifest as Record<string, unknown> | null)?.version as string | undefined) ?? null;

  let latestVersion: string | null = null;
  if (latestTag) {
    const [row] = await db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.id, latestTag.versionId))
      .limit(1);
    latestVersion = row?.version ?? null;
  }

  return { latestVersion, draftVersion };
}

// ─────────────────────────────────────────────
// Draft → version helpers
// ─────────────────────────────────────────────

/** Get the createdAt of the latest version for a package. Returns null if no versions exist. */
export async function getLatestVersionCreatedAt(packageId: string): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: packageVersions.createdAt })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId))
    .orderBy(desc(packageVersions.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}

/** Create an immutable version snapshot from the current draft (packages table).
 *  Uses manifest.version as-is — no auto-bump. Returns null if version is missing,
 *  invalid, or fails forward-only validation (handled by createPackageVersion). */
export async function createVersionFromDraft(params: {
  packageId: string;
  orgId: string;
  userId: string;
}): Promise<{ id: number; version: string } | null> {
  const { packageId, orgId, userId } = params;

  const [pkg] = await db
    .select({ manifest: packages.manifest, content: packages.content, type: packages.type })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);

  if (!pkg) return null;

  const baseManifest = pkg.manifest as Record<string, unknown>;
  const content = pkg.content as string;
  const version = baseManifest.version as string | undefined;

  if (!version || !isValidVersion(version)) return null;

  const manifest = { ...baseManifest, version };

  // Enrich manifest with registryDependencies so the version ZIP
  // matches what would be published to the registry (same integrity).
  // Now that providers are in packageDependencies, the join query picks them up automatically.
  const registryDeps = await buildRegistryDependencies(packageId, orgId);
  const parsed = parseScopedName(baseManifest.name as string);
  const finalManifest = parsed
    ? prepareManifestForPublish(manifest, parsed.scope, parsed.name, version, registryDeps)
    : manifest;

  // Build ZIP depending on package type
  let zipBuffer: Buffer;
  if (pkg.type === "provider") {
    // Providers store everything in manifest — ZIP contains only manifest.json
    const { zipArtifact } = await import("@appstrate/core/zip");
    const entries: Record<string, Uint8Array> = {
      "manifest.json": new TextEncoder().encode(JSON.stringify(finalManifest, null, 2)),
    };
    zipBuffer = Buffer.from(zipArtifact(entries, 6));
  } else if (pkg.type === "flow") {
    const { buildMinimalZip } = await import("./package-storage.ts");
    zipBuffer = buildMinimalZip(finalManifest, content);
  } else {
    // For skills/extensions, build ZIP from storage files or content
    const { downloadPackageFiles } = await import("./package-items/storage.ts");
    const files = await downloadPackageFiles(
      pkg.type === "skill" ? "skills" : "extensions",
      orgId,
      packageId,
    );
    if (files) {
      const { zipArtifact } = await import("@appstrate/core/zip");
      // Include manifest.json if available
      const entries: Record<string, Uint8Array> = { ...files };
      entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(finalManifest, null, 2));
      zipBuffer = Buffer.from(zipArtifact(entries, 6));
    } else {
      // Fallback: create minimal ZIP with manifest + content using correct filename
      const { buildMinimalZip } = await import("./package-storage.ts");
      const contentFileName =
        pkg.type === "skill" ? "SKILL.md" : `${parseScopedName(packageId)?.name ?? packageId}.ts`;
      zipBuffer = buildMinimalZip(finalManifest, content, contentFileName);
    }
  }

  return createVersionAndUpload({
    packageId,
    version,
    orgId,
    createdBy: userId,
    zipBuffer,
    manifest: finalManifest,
  });
}

// ─────────────────────────────────────────────
// Replace existing version content
// ─────────────────────────────────────────────

/** Replace the content of an existing version (integrity, artifactSize, manifest) and re-upload ZIP. */
export async function replaceVersionContent(params: {
  packageId: string;
  version: string;
  zipBuffer: Buffer;
  manifest: Record<string, unknown>;
}): Promise<void> {
  const { packageId, version, zipBuffer, manifest } = params;
  const integrity = computeIntegrity(new Uint8Array(zipBuffer));
  const artifactSize = zipBuffer.byteLength;

  const [row] = await db
    .update(packageVersions)
    .set({ integrity, artifactSize, manifest })
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
    .returning({ id: packageVersions.id });

  if (!row) {
    logger.warn("replaceVersionContent: version row not found", { packageId, version });
    return;
  }

  await uploadPackageZip(packageId, version, zipBuffer);

  // Clear old deps and re-store from new manifest
  await clearVersionDependencies(row.id);
  const deps = extractDependencies(manifest);
  if (deps.length > 0) {
    await storeVersionDependencies(row.id, deps);
  }

  logger.info("Replaced version content", { packageId, version, integrity });
}

// ─────────────────────────────────────────────
// Convenience: create version + upload ZIP
// ─────────────────────────────────────────────

/** Create a version snapshot and upload the ZIP to Storage in one call. */
export async function createVersionAndUpload(params: {
  packageId: string;
  version: string;
  orgId: string | null;
  createdBy: string | null;
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
