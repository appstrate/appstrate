// SPDX-License-Identifier: Apache-2.0

import { eq, and, desc, count, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageVersions, packageDistTags } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import {
  uploadPackageZip,
  downloadVersionZip,
  deleteVersionZip,
  unzipAndNormalize,
  buildMinimalZip,
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

import { buildDependencies } from "./package-items/dependencies.ts";
import { parseScopedName } from "@appstrate/core/naming";
import { zipArtifact } from "@appstrate/core/zip";
import { buildPublishedToolArchive } from "@appstrate/core/tool-bundler";
import { asRecord, asRecordOrNull } from "../lib/safe-json.ts";
import { downloadPackageFiles } from "./package-items/storage.ts";
import { toISO } from "../lib/date-helpers.ts";

// ─────────────────────────────────────────────
// Version creation
// ─────────────────────────────────────────────

interface CreateVersionParams {
  packageId: string;
  version: string;
  integrity: string;
  artifactSize: number;
  manifest: Record<string, unknown>;
  createdBy: string | null;
}

/** Create a new version with semver, integrity, manifest snapshot. Auto-manages "latest" dist-tag. */
export async function createPackageVersion(params: CreateVersionParams): Promise<{
  id: number;
  version: string;
} | null> {
  const { packageId, version, integrity, artifactSize, manifest, createdBy } = params;

  if (!isValidVersion(version)) {
    logger.error("Invalid semver version", { packageId, version });
    return null;
  }

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${packageId}))`);

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
        logger.warn("Version rejected", {
          packageId,
          version,
          error: outcome.error,
          highest: outcome.error === "VERSION_NOT_HIGHER" ? outcome.highest : undefined,
        });
        return null;
      }

      const [row] = await tx
        .insert(packageVersions)
        .values({ packageId, version, integrity, artifactSize, manifest, createdBy })
        .returning({ id: packageVersions.id, version: packageVersions.version });

      // Auto-manage "latest" dist-tag
      if (outcome.shouldUpdateLatest) {
        await tx
          .insert(packageDistTags)
          .values({ packageId, tag: "latest", versionId: row!.id })
          .onConflictDoUpdate({
            target: [packageDistTags.packageId, packageDistTags.tag],
            set: { versionId: row!.id, updatedAt: new Date() },
          });
      }

      return { id: row!.id, version: row!.version };
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
    createdAt: toISO(r.createdAt),
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

/** Get the latest version ID + version string + createdAt for dirty-check at run time. */
export async function getLatestVersionInfo(
  packageId: string,
): Promise<{ id: number; version: string; createdAt: Date } | null> {
  const versionId = await getLatestVersionId(packageId);
  if (!versionId) return null;

  const [row] = await db
    .select({
      id: packageVersions.id,
      version: packageVersions.version,
      createdAt: packageVersions.createdAt,
    })
    .from(packageVersions)
    .where(eq(packageVersions.id, versionId))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    createdAt: row.createdAt,
  };
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

interface VersionDetail {
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
    manifest: asRecord(row.manifest),
    textContent,
    content,
    yanked: row.yanked,
    yankedReason: row.yankedReason,
    integrity: row.integrity,
    artifactSize: row.artifactSize,
    createdAt: toISO(row.createdAt),
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

// ─────────────────────────────────────────────
// Delete version
// ─────────────────────────────────────────────

/** Permanently delete a version. Reassigns dist-tags, then removes the DB row and storage artifact. */
export async function deletePackageVersion(packageId: string, version: string): Promise<boolean> {
  const deleted = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${packageId}))`);

    // Find the version row
    const [row] = await tx
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
      .limit(1);

    if (!row) return false;

    // Reassign dist-tags that point to this version before deleting
    const affectedTags = await tx
      .select({ tag: packageDistTags.tag })
      .from(packageDistTags)
      .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.versionId, row.id)));

    if (affectedTags.length > 0) {
      // Candidates = all non-yanked versions EXCEPT the one being deleted
      const candidates = await tx
        .select({ id: packageVersions.id, version: packageVersions.version })
        .from(packageVersions)
        .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.yanked, false)));

      const filteredCandidates = candidates.filter((c) => c.id !== row.id);
      const instructions = planTagReassignment(affectedTags, filteredCandidates);

      for (const instr of instructions) {
        if (instr.action === "reassign") {
          await tx
            .update(packageDistTags)
            .set({ versionId: instr.newVersionId, updatedAt: new Date() })
            .where(
              and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, instr.tag)),
            );
        } else {
          await tx
            .delete(packageDistTags)
            .where(
              and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, instr.tag)),
            );
        }
      }
    }

    // Delete the version row (CASCADE removes packageVersionDependencies)
    await tx.delete(packageVersions).where(eq(packageVersions.id, row.id));

    return true;
  });

  if (deleted) {
    // Best-effort storage cleanup (outside transaction — don't fail if missing)
    await deleteVersionZip(packageId, version);
    logger.info("Deleted package version", { packageId, version });
  }

  return deleted;
}

// ─────────────────────────────────────────────
// Dist-tags
// ─────────────────────────────────────────────

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

/** Return the latest published version and the current active version from the manifest. */
export async function getVersionInfo(
  packageId: string,
  orgId: string,
): Promise<{ latestPublishedVersion: string | null; activeVersion: string | null }> {
  const [[pkg], [latestTag]] = await Promise.all([
    db
      .select({ draftManifest: packages.draftManifest })
      .from(packages)
      .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)))
      .limit(1),
    db
      .select({ versionId: packageDistTags.versionId })
      .from(packageDistTags)
      .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, "latest")))
      .limit(1),
  ]);

  const draftManifest = asRecordOrNull(pkg?.draftManifest);
  const activeVersion = typeof draftManifest?.version === "string" ? draftManifest.version : null;

  let latestPublishedVersion: string | null = null;
  if (latestTag) {
    const [row] = await db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.id, latestTag.versionId))
      .limit(1);
    latestPublishedVersion = row?.version ?? null;
  }

  return { latestPublishedVersion, activeVersion };
}

// ─────────────────────────────────────────────
// Unpublished changes detection
// ─────────────────────────────────────────────

/** Whether the active draft has changes not yet archived as a version. */
export function computeHasUnpublishedChanges(
  source: string,
  versionCount: number,
  updatedAt: Date | null,
  latestVersionDate: Date | null,
): boolean {
  if (source === "system") return false;
  if (versionCount === 0) return true;
  if (!latestVersionDate) return false;
  return (updatedAt ?? new Date()) > latestVersionDate;
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

/** Get the integrity hash of the latest version. Returns null if no versions exist. */
export async function getLatestVersionIntegrity(packageId: string): Promise<string | null> {
  const [row] = await db
    .select({ integrity: packageVersions.integrity })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId))
    .orderBy(desc(packageVersions.createdAt))
    .limit(1);
  return row?.integrity ?? null;
}

type CreateVersionError = "invalid_version" | "no_changes";
type CreateVersionResult = { id: number; version: string } | { error: CreateVersionError };

/** Create an immutable version snapshot from the current draft (packages table).
 *  Uses manifest.version as-is — no auto-bump. Returns an error object if version is missing,
 *  invalid, fails forward-only validation, or content is identical to the latest version. */
export async function createVersionFromDraft(params: {
  packageId: string;
  orgId: string;
  userId: string;
  version?: string;
}): Promise<CreateVersionResult> {
  const { packageId, orgId, userId } = params;

  const [pkg] = await db
    .select({
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
      type: packages.type,
    })
    .from(packages)
    .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)))
    .limit(1);

  if (!pkg) return { error: "invalid_version" };

  const baseManifest = asRecord(pkg.draftManifest);
  const content = (pkg.draftContent ?? "") as string;

  // Use override version if provided, otherwise use manifest version
  const version =
    params.version ?? (typeof baseManifest.version === "string" ? baseManifest.version : undefined);

  if (!version || !isValidVersion(version)) return { error: "invalid_version" };

  // If override version differs from manifest, sync the draft manifest in DB
  if (params.version && params.version !== baseManifest.version) {
    await db
      .update(packages)
      .set({ draftManifest: { ...baseManifest, version: params.version } })
      .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)));
  }

  const manifest = { ...baseManifest, version };

  // Enrich manifest with dependencies so the version ZIP
  // matches what would be published to the registry (same integrity).
  const deps = await buildDependencies(packageId);
  const parsed = typeof baseManifest.name === "string" ? parseScopedName(baseManifest.name) : null;
  let finalManifest: Record<string, unknown>;
  if (parsed) {
    finalManifest = { ...manifest, name: `@${parsed.scope}/${parsed.name}`, version };
    if (deps) {
      finalManifest.dependencies = deps;
    } else {
      delete finalManifest.dependencies;
    }
  } else {
    finalManifest = manifest;
  }

  // Build ZIP depending on package type
  let zipBuffer: Buffer;
  if (pkg.type === "provider") {
    // Providers store everything in manifest — ZIP contains only manifest.json
    const entries: Record<string, Uint8Array> = {
      "manifest.json": new TextEncoder().encode(JSON.stringify(finalManifest, null, 2)),
    };
    zipBuffer = Buffer.from(zipArtifact(entries, 6));
  } else if (pkg.type === "agent") {
    const storedFiles = await downloadPackageFiles("agents", orgId, packageId);
    if (storedFiles) {
      const entries: Record<string, Uint8Array> = { ...storedFiles };
      entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(finalManifest, null, 2));
      entries["prompt.md"] = new TextEncoder().encode(content);
      zipBuffer = Buffer.from(zipArtifact(entries, 6));
    } else {
      // Locally-created agents have no stored files — minimal ZIP is correct
      zipBuffer = buildMinimalZip(finalManifest, content);
    }
  } else if (pkg.type === "skill") {
    const files = await downloadPackageFiles("skills", orgId, packageId);
    if (!files) {
      throw new Error(
        `Cannot create version for ${packageId}: package files not found in storage. Re-upload the package before creating a version.`,
      );
    }
    const entries: Record<string, Uint8Array> = { ...files };
    entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(finalManifest, null, 2));
    zipBuffer = Buffer.from(zipArtifact(entries, 6));
  } else {
    // pkg.type === "tool" — bundle the draft's entrypoint into a
    // self-contained `tool.js` and rewrite `manifest.entrypoint`
    // accordingly (AFPS §3.4). See `@appstrate/core/tool-bundler`.
    const files = await downloadPackageFiles("tools", orgId, packageId);
    if (!files) {
      throw new Error(
        `Cannot create version for ${packageId}: package files not found in storage. Re-upload the package before creating a version.`,
      );
    }
    const toolIdForLogs = typeof finalManifest.name === "string" ? finalManifest.name : packageId;
    const built = await buildPublishedToolArchive({
      files,
      manifest: finalManifest,
      toolId: toolIdForLogs,
    });
    finalManifest = built.manifest;
    zipBuffer = Buffer.from(built.archive);
  }

  // Check for duplicate content — reject if identical to the latest version
  const newIntegrity = computeIntegrity(new Uint8Array(zipBuffer));
  const latestIntegrity = await getLatestVersionIntegrity(packageId);
  if (latestIntegrity && newIntegrity === latestIntegrity) {
    return { error: "no_changes" };
  }

  const result = await createVersionAndUpload({
    packageId,
    version,
    createdBy: userId,
    zipBuffer,
    manifest: finalManifest,
  });
  return result ?? { error: "invalid_version" };
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

  // Upload ZIP first to avoid integrity mismatch if upload fails after DB update
  await uploadPackageZip(packageId, version, zipBuffer);

  const [row] = await db
    .update(packageVersions)
    .set({ integrity, artifactSize, manifest })
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
    .returning({ id: packageVersions.id });

  if (!row) {
    logger.warn("replaceVersionContent: version row not found", { packageId, version });
    return;
  }

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
  createdBy: string | null;
  zipBuffer: Buffer;
  manifest: Record<string, unknown>;
}): Promise<{ id: number; version: string } | null> {
  const { packageId, version, createdBy, zipBuffer, manifest } = params;

  const integrity = computeIntegrity(new Uint8Array(zipBuffer));
  const artifactSize = zipBuffer.byteLength;

  // Upload ZIP first — a ZIP without a DB row is safer than a DB row without a ZIP
  await uploadPackageZip(packageId, version, zipBuffer);

  try {
    const result = await createPackageVersion({
      packageId,
      version,
      integrity,
      artifactSize,
      manifest,
      createdBy,
    });

    if (result) {
      const deps = extractDependencies(manifest);
      if (deps.length > 0) {
        await storeVersionDependencies(result.id, deps);
      }
    }

    return result;
  } catch (err) {
    // Clean up uploaded ZIP on DB failure (best-effort — don't mask original error)
    try {
      await deleteVersionZip(packageId, version);
    } catch {
      logger.warn("Failed to clean up ZIP after DB error", { packageId, version });
    }
    throw err;
  }
}
