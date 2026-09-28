// SPDX-License-Identifier: Apache-2.0

import type { PackageVersionInfoResponse } from "@appstrate/shared-types";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageVersions, packageDistTags } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { ApiError } from "../lib/errors.ts";
import {
  uploadPackageZip,
  downloadVersionZip,
  downloadVersionZipForExecution,
  deleteVersionZip,
  buildMinimalZip,
} from "./package-storage.ts";
import { unzipPackageArchive } from "./package-archive.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { computeIntegrity } from "@appstrate/core/integrity";
import { extractDependencies, detectCycle, type DepEntry } from "@appstrate/core/dependencies";
import { storeVersionDependencies, clearVersionDependencies } from "./package-version-deps.ts";
import { packageVersionDependencies } from "@appstrate/db/schema";
import {
  isValidVersion,
  resolveVersionFromCatalog,
  type CatalogVersion,
  type DistTagEntry,
} from "@appstrate/core/semver";
import { planCreateVersionOutcome, planTagReassignment } from "@appstrate/core/version-policy";

import { parseScopedName } from "@appstrate/core/naming";
import { PACKAGE_CONTENT_ENTRY } from "@appstrate/core/package-files";
import { dropRetiredRuntimeTools, type PackageType } from "@appstrate/core/validation";
import { parsePackageZip, zipArtifact } from "@appstrate/core/zip";
import { asRecord, asRecordOrNull } from "@appstrate/core/safe-json";
import { decodeSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { downloadPackageFiles } from "./package-items/storage.ts";
import { storageFolderForType, assertArchiveContentConforms } from "./package-items/config.ts";
import { toISO } from "../lib/date-helpers.ts";
import type { DbOrTx } from "../lib/db-helpers.ts";
import { enqueueStorageDeletion } from "./storage-deletion.ts";
import { AGENT_PACKAGES_BUCKET, versionZipKey } from "./package-storage-keys.ts";
import { withPackageDraftLock } from "./package-draft-lock.ts";
import { toBundleApiError } from "./run-launcher/bundle-error-mapping.ts";

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
  /**
   * Derived dependency index rows (from `extractDependencies`). Inserted in
   * the SAME transaction as the version row so the row and its index commit
   * (or roll back) atomically — never a committed version with a missing or
   * partial index.
   */
  deps?: DepEntry[];
  /**
   * Artifact upload, invoked INSIDE the transaction and ONLY when the outcome
   * is `created` — i.e. strictly after the forward-only/exists decision, while
   * the per-package advisory lock is held. This ordering is the #896 fix:
   * uploading before the decision let an `exists` republish overwrite the
   * published bytes while the row kept the old integrity hash (a permanent
   * `bundle_integrity_mismatch` at run time), and let a `rejected` republish
   * clobber-then-delete a perfectly good artifact. An upload failure rolls the
   * version row back, so a committed row always had a successful upload.
   */
  uploadZip?: () => Promise<void>;
}

/**
 * Create a new version with semver, integrity, manifest snapshot. Auto-manages
 * "latest" dist-tag.
 *
 * Returns `null` ONLY for the legitimate no-op cases — an invalid semver, a
 * version that already exists (with no row to return), or a forward-only
 * rejection. A genuine DB failure THROWS so callers can distinguish a real
 * error from a benign skip. A returned row carries `outcome` so callers can
 * tell a fresh publish (`created`) from an already-existing version
 * (`exists`) — the latter never touches the stored artifact.
 */
export async function createPackageVersion(params: CreateVersionParams): Promise<{
  id: number;
  version: string;
  outcome: "created" | "exists";
} | null> {
  const { packageId, version, integrity, artifactSize, manifest, createdBy, deps, uploadZip } =
    params;

  if (!isValidVersion(version)) {
    logger.error("Invalid semver version", { packageId, version });
    return null;
  }

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
      // Published versions are immutable: return the existing row WITHOUT
      // touching the stored artifact. Overwriting the bytes here while keeping
      // the row's integrity hash is exactly the corruption reported in #896.
      logger.warn("Version already exists", { packageId, version });
      const [existingRow] = await tx
        .select({ id: packageVersions.id, version: packageVersions.version })
        .from(packageVersions)
        .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
        .limit(1);
      return existingRow ? { ...existingRow, outcome: "exists" as const } : null;
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

    // Derived dependency index — same transaction as the row, so a version is
    // never committed with a missing/partial index.
    if (deps && deps.length > 0) {
      await storeVersionDependencies(row!.id, deps, tx);
    }

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

    // Upload the artifact only now that the outcome is decided as `created`,
    // still inside the transaction: an upload failure rolls the row back, so
    // a committed row is never left pointing at absent bytes, and a rejected
    // or already-existing version never has its published bytes overwritten
    // (#896). Holding the per-package advisory lock across the upload is the
    // accepted cost — it only serializes publishes of the SAME package.
    if (uploadZip) {
      await uploadZip();
    }

    return { id: row!.id, version: row!.version, outcome: "created" as const };
  });
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
      artifact_size: packageVersions.artifactSize,
      yanked: packageVersions.yanked,
      created_by: packageVersions.createdBy,
      createdAt: packageVersions.createdAt,
    })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId))
    .orderBy(desc(packageVersions.createdAt), desc(packageVersions.id));

  return rows.map((r) => ({
    ...r,
    createdAt: toISO(r.createdAt),
  }));
}

/** Get the latest version ID for a package via the "latest" dist-tag. */
export async function getLatestVersionId(packageId: string): Promise<number | null> {
  const [tag] = await db
    .select({ versionId: packageDistTags.versionId })
    .from(packageDistTags)
    .where(and(eq(packageDistTags.packageId, packageId), eq(packageDistTags.tag, "latest")))
    .limit(1);

  return tag?.versionId ?? null;
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

/**
 * Exact-version manifest lookup — the light read for run-scoped consumers
 * that need a published manifest WITHOUT the artifact bytes. The run's
 * `version_ref` is a concrete semver stamped at kickoff, so no spec
 * resolution (dist-tag / range) applies here. Returns null when the version
 * row is absent (never published, or deleted after kickoff).
 */
export async function getExactVersionManifest(
  packageId: string,
  version: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ manifest: packageVersions.manifest })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
    .limit(1);
  return asRecordOrNull(row?.manifest);
}

/** 3-step version resolution: exact → dist-tag → semver range. */
export async function resolveVersion(
  packageId: string,
  query: string,
  executor: DbOrTx = db,
): Promise<number | null> {
  const allVersions: CatalogVersion[] = await executor
    .select({
      id: packageVersions.id,
      version: packageVersions.version,
      yanked: packageVersions.yanked,
    })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId));

  const allDistTags: DistTagEntry[] = await executor
    .select({ tag: packageDistTags.tag, versionId: packageDistTags.versionId })
    .from(packageDistTags)
    .where(eq(packageDistTags.packageId, packageId));

  return resolveVersionFromCatalog(query, allVersions, allDistTags);
}

/** Get a version row suitable for download (via 3-step resolution). Returns null if not found. */
export async function getVersionForDownload(
  packageId: string,
  versionSpec: string,
): Promise<{
  id: number;
  version: string;
  integrity: string;
  artifactSize: number;
  yanked: boolean;
} | null> {
  const versionId = await resolveVersion(packageId, versionSpec);
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
  content: Record<string, Uint8Array> | null;
  yanked: boolean;
  yankedReason: string | null;
  integrity: string;
  artifactSize: number;
  createdAt: string | null;
}

/**
 * Resolve a version query and return full version data including the files of its ZIP.
 * Returns null if the version cannot be resolved. See {@link readVersionArchive} for `content`.
 */
export async function getVersionDetail(
  packageId: string,
  versionSpec: string,
  /**
   * `forExecution`: the version will run — apply the AFPS signature policy to its
   * bytes. `executor`: read the catalog inside the caller's transaction.
   */
  opts: { forExecution?: boolean; executor?: DbOrTx } = {},
): Promise<VersionDetail | null> {
  const row = await getVersionRow(packageId, versionSpec, opts.executor);
  if (!row) return null;
  return { ...row, content: await readVersionArchive(packageId, row.version, opts) };
}

/** A version's catalog row — {@link getVersionDetail} without reading its archive. */
export async function getVersionRow(
  packageId: string,
  versionSpec: string,
  executor: DbOrTx = db,
): Promise<Omit<VersionDetail, "content"> | null> {
  const versionId = await resolveVersion(packageId, versionSpec, executor);
  if (!versionId) return null;

  const [row] = await executor
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
  return {
    id: row.id,
    version: row.version,
    manifest: asRecord(row.manifest),
    yanked: row.yanked,
    yankedReason: row.yankedReason,
    integrity: row.integrity,
    artifactSize: row.artifactSize,
    createdAt: toISO(row.createdAt),
  };
}

/**
 * A published version's files: null when the object is absent or will not unzip — a
 * reader that needs the bytes goes through {@link requirePublishedArchive}. Storage errors
 * propagate; bundle-layer refusals (the signature gate of an execution read) are coded (#878).
 */
export async function readVersionArchive(
  packageId: string,
  version: string,
  /** The version will run: apply the AFPS signature policy to its bytes. */
  opts: { forExecution?: boolean } = {},
): Promise<Record<string, Uint8Array> | null> {
  const download = opts.forExecution ? downloadVersionZipForExecution : downloadVersionZip;
  let zipBuffer: Buffer | null;
  try {
    zipBuffer = await download(packageId, version);
  } catch (err) {
    throw toBundleApiError(err) ?? err;
  }
  if (!zipBuffer) return null;
  try {
    return unzipPackageArchive(zipBuffer);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logger.warn("Failed to extract ZIP for version detail", {
      packageId,
      version,
      error: getErrorMessage(err),
    });
    return null;
  }
}

/**
 * `422 version_artifact_unavailable`: a version that EXISTS but whose bytes cannot be
 * read — a broken artifact, never a missing version. The only place this refusal is
 * built, so the one place it is logged for ops.
 */
export function versionArtifactUnavailable(
  packageId: string,
  version: string,
  what = "archive",
): ApiError {
  logger.warn("Published version artifact unavailable", { packageId, version, what });
  return new ApiError({
    status: 422,
    code: "version_artifact_unavailable",
    title: "Version Artifact Unavailable",
    detail: `Published '${packageId}@${version}' has no readable ${what}`,
  });
}

/**
 * The archive of a published version, or {@link versionArtifactUnavailable} when it is
 * unreadable or lacks its type's REQUIRED content entry (`PACKAGE_CONTENT_ENTRY`).
 * `entry` is that entry's bytes; `undefined` when the type has none or the optional one is absent.
 */
export function requirePublishedArchive(
  type: PackageType,
  packageId: string,
  detail: Pick<VersionDetail, "version" | "content">,
): { files: Record<string, Uint8Array>; entry: Uint8Array | undefined } {
  if (detail.content === null) throw versionArtifactUnavailable(packageId, detail.version);
  const spec = PACKAGE_CONTENT_ENTRY[type];
  const entry = spec ? detail.content[spec.path] : undefined;
  if (spec?.required && !entry) {
    throw versionArtifactUnavailable(packageId, detail.version, `'${spec.path}' in its archive`);
  }
  return { files: detail.content, entry };
}

/**
 * The decoded `prompt.md` of a published agent version, via {@link requirePublishedArchive},
 * which refuses a version without one (`prompt.md` is required for an agent).
 */
export function requirePublishedPrompt(
  packageId: string,
  detail: Pick<VersionDetail, "version" | "content">,
): string {
  return new TextDecoder().decode(requirePublishedArchive("agent", packageId, detail).entry);
}

/** {@link loadPublishedDefinition}'s projection — `getOrgItem`'s fields, from a snapshot. */
export interface PublishedDefinition {
  name: string;
  description: string | null;
  version: string | null;
  manifest_name: string | null;
  manifest: Record<string, unknown>;
  content: string;
}

/**
 * The manifest-derived half of a package detail, read from a PUBLISHED
 * snapshot instead of the draft columns — `getOrgItem`'s projection applied to
 * a version's own manifest and archive, so the two halves of a detail response
 * never come from two different definitions. `null` when `spec` resolves to no
 * version.
 *
 * The manifest is the `package_versions.manifest` column: authoritative, one
 * DB read, and immune to an archive that will not open. The CONTENT is the
 * archive entry this type is authored around ({@link PACKAGE_CONTENT_ENTRY}),
 * and the fallbacks below are the exact inverse of `applyDraftOverlay`: a type
 * with no content entry at all (`mcp-server`, whose content IS its manifest)
 * and an `integration` published without its optional `INTEGRATION.md` both
 * store the manifest TEXT in `draft_content`, so the published projection
 * reproduces that rather than handing back a `null` the editor would render as
 * an empty file.
 *
 * That fallback stands only for an entry missing from an archive that opened:
 * an unreadable archive, or one without a REQUIRED entry, is refused by
 * {@link requirePublishedArchive} — the same 422 the run and restore paths answer.
 */
export async function loadPublishedDefinition(
  type: PackageType,
  packageId: string,
  spec: string,
  executor?: DbOrTx,
): Promise<PublishedDefinition | null> {
  const detail = await getVersionDetail(packageId, spec, { executor });
  if (!detail) return null;
  const m = asRecord(detail.manifest);
  const { entry } = requirePublishedArchive(type, packageId, detail);
  return {
    // Same projection `getOrgItem` runs over the draft manifest, field for
    // field: a reader must not be able to tell which definition answered by
    // the SHAPE of what came back.
    name: typeof m.display_name === "string" ? m.display_name : packageId,
    description: typeof m.description === "string" ? m.description : null,
    version: typeof m.version === "string" ? m.version : null,
    manifest_name: typeof m.name === "string" ? m.name : null,
    manifest: m,
    content: entry ? decodeSkillMarkdown(entry) : JSON.stringify(m, null, 2),
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
      .limit(1)
      .for("update");

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

    // Purge the artifact through the transactional outbox, IN THIS TRANSACTION
    // — was a best-effort `deleteVersionZip` after commit, whose failure (or a
    // crash in the window) silently orphaned the ZIP forever. The outbox row
    // commits atomically with the row delete, so the worker retries the
    // idempotent physical delete until it succeeds.
    await enqueueStorageDeletion(tx, {
      bucket: AGENT_PACKAGES_BUCKET,
      storageKey: versionZipKey(packageId, version),
      reason: "version_deleted",
    });

    return true;
  });

  if (deleted) {
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
): Promise<PackageVersionInfoResponse> {
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

  return { latest_published_version: latestPublishedVersion, active_version: activeVersion };
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
async function getLatestVersionIntegrity(packageId: string): Promise<string | null> {
  const [row] = await db
    .select({ integrity: packageVersions.integrity })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId))
    .orderBy(desc(packageVersions.createdAt))
    .limit(1);
  return row?.integrity ?? null;
}

type CreateVersionError = "invalid_version" | "invalid_bundle" | "no_changes" | "version_exists";
type CreateVersionResult =
  { id: number; version: string } | { error: CreateVersionError; detail?: string };

/** Create an immutable version snapshot from the current draft (packages table).
 *  Uses manifest.version as-is — no auto-bump. Returns an error object if version is missing,
 *  invalid, fails forward-only validation, or content is identical to the latest version.
 *  A draft whose content changed but whose version was not bumped yields `version_exists`
 *  (published versions are immutable — the old silent-success path overwrote the stored
 *  bytes while keeping the stale integrity row, #896). */
export async function createVersionFromDraft(params: {
  packageId: string;
  orgId: string;
  userId: string;
  version?: string;
  /**
   * Asserts the draft version the caller read (the route's `If-Match`) against
   * the snapshot taken under the draft lock; when it throws, nothing is cut.
   */
  assertVersion?: (current: number) => void;
  /** Context-dependent publish gates must validate the captured manifest. */
  validateManifest?: (manifest: Record<string, unknown>, type: PackageType) => Promise<unknown>;
}): Promise<CreateVersionResult> {
  const { packageId, orgId, userId } = params;

  // Capture both stores while saves/imports/restores are excluded. Release the
  // lock before context-dependent validation and immutable-version creation:
  // those use their own DB connections, and must never nest under this lock.
  const snapshot = await withPackageDraftLock(packageId, async (tx) => {
    const [pkg] = await tx
      .select({
        draftManifest: packages.draftManifest,
        draftContent: packages.draftContent,
        type: packages.type,
        lockVersion: packages.lockVersion,
      })
      .from(packages)
      .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)))
      .limit(1);
    if (!pkg) return null;
    const storedFiles = await downloadPackageFiles(
      storageFolderForType(pkg.type),
      orgId,
      packageId,
    );
    return { pkg, storedFiles };
  });
  if (!snapshot) return { error: "invalid_version" };
  const { pkg, storedFiles } = snapshot;
  params.assertVersion?.(pkg.lockVersion);

  const baseManifest = asRecord(pkg.draftManifest);
  const content = (pkg.draftContent ?? "") as string;

  // Use override version if provided, otherwise use manifest version
  const version =
    params.version ?? (typeof baseManifest.version === "string" ? baseManifest.version : undefined);

  if (!version || !isValidVersion(version)) return { error: "invalid_version" };

  const manifest = { ...baseManifest, version };

  // The draft manifest is the single source of truth for dependencies
  // (skills / integrations / mcp_servers) — the editor maintains them
  // directly. Publish preserves the `dependencies` block verbatim, exactly
  // like every other version-creation path (import, fork, system sync). The
  // transitive skill closure and version resolution happen at bundle time
  // (`buildBundleFromCatalog`), and the derived per-version dependency index
  // is rebuilt downstream from this manifest via `extractDependencies`.
  const parsed = typeof baseManifest.name === "string" ? parseScopedName(baseManifest.name) : null;
  const rawManifest: Record<string, unknown> = parsed
    ? { ...manifest, name: `@${parsed.scope}/${parsed.name}`, version }
    : manifest;

  // Normalise BEFORE the snapshot. A version freezes its manifest twice — the
  // `package_versions.manifest` row and the integrity-checked ZIP — and both
  // are immutable afterwards. Freezing the draft verbatim would mint a brand
  // new artifact carrying a `runtime_tools` id the platform retired *before*
  // this publish, i.e. create the very legacy the read paths then have to
  // tolerate forever. The drop is structural (no Zod re-parse): key order and
  // unknown fields survive byte-for-byte, so a draft with nothing to drop
  // yields the exact same bytes as before and publish dedup (#896) is
  // unaffected.
  const { manifest: finalManifest, dropped: droppedRuntimeTools } =
    dropRetiredRuntimeTools(rawManifest);
  if (droppedRuntimeTools.length > 0) {
    logger.info("dropped retired runtime tools from published manifest", {
      packageId,
      version,
      dropped: droppedRuntimeTools,
    });
  }

  await params.validateManifest?.(finalManifest, pkg.type);

  // Build ZIP depending on package type. A function of the manifest, because
  // the duplicate-content check below freezes the same draft a second time
  // under a different `version`.
  const buildArtifact = (
    frozenManifest: Record<string, unknown>,
  ): { zip: Buffer; entries?: Record<string, Uint8Array> } => {
    if (pkg.type === "agent") {
      if (storedFiles) {
        const entries: Record<string, Uint8Array> = { ...storedFiles };
        entries["manifest.json"] = new TextEncoder().encode(
          JSON.stringify(frozenManifest, null, 2),
        );
        entries["prompt.md"] = new TextEncoder().encode(content);
        return { zip: Buffer.from(zipArtifact(entries, 6)) };
      }
      // Locally-created agents have no stored files — minimal ZIP is correct
      return { zip: buildMinimalZip(frozenManifest, content) };
    }
    // pkg.type === "skill" | "integration" | "mcp-server" — all three bundle
    // their stored files (skill content / integration entrypoint+bundle /
    // MCPB payload) plus the rewritten manifest, from their respective storage
    // folder. The folder MUST come from `storageFolderForType` — the single
    // mapping the upload path (`routes/packages.ts`), the deletion outbox and
    // the orphan scanner all use. A hand-rolled ternary here silently sent
    // `mcp-server` reads to `skills/`.
    if (!storedFiles) {
      throw new Error(
        `Cannot create version for ${packageId}: package files not found in storage. Re-upload the package before creating a version.`,
      );
    }
    const entries: Record<string, Uint8Array> = { ...storedFiles };
    entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(frozenManifest, null, 2));
    return { zip: Buffer.from(zipArtifact(entries, 6)), entries };
  };
  const { zip: zipBuffer, entries: frozenEntries } = buildArtifact(finalManifest);

  // The bytes that ACTUALLY get frozen: the artifact's content entry comes from
  // STORAGE, and `packages.draft_content` is a second copy that can drift.
  if (frozenEntries) assertArchiveContentConforms(pkg.type, frozenEntries, "content");

  // A schema-valid mcp-server draft can still point at a companion file that
  // is absent from the stored payload. Reparse the exact bytes about to become
  // immutable so publish enforces the same executable-archive invariant as
  // create and import.
  //
  // Keyed on `pkg.type` ALONE. This used to also require
  // `finalManifest.type === "mcp-server"`, exempting a row whose stored
  // manifest had drifted to another type — which meant the one row shape that
  // cannot be trusted was the one that skipped the check, minting an immutable
  // version + ZIP nothing ever validated. Every write direction is closed:
  // create throws (`package-items/manifest.ts`), the author routes 400
  // (`validateManifestForRoute`), fork normalizes (`package-fork.ts`), and
  // #987 closed the last one. A surviving drifted row now fails publish loudly
  // with `invalid_bundle` instead of publishing unchecked
  // (`docs/NO_TRANSITIONAL_CODE.md` §1).
  if (pkg.type === "mcp-server") {
    try {
      parsePackageZip(new Uint8Array(zipBuffer), { retiredRuntimeTools: "drop" });
    } catch (err) {
      return { error: "invalid_bundle", detail: getErrorMessage(err) };
    }
  }

  // Check for duplicate content — reject if identical to the latest version.
  // An OVERRIDE is a number the publish surface picks for a draft still at
  // the published version (the dialog's bump, `packages publish --bump`); it
  // is not a change, so the draft is compared under its OWN version. A
  // version the author wrote into the manifest is compared as is: promoting
  // `1.0.0-rc.1` to `1.0.0`, or deliberately re-cutting content, is theirs.
  const ownVersion = baseManifest.version;
  const comparable =
    params.version !== undefined && params.version !== ownVersion
      ? buildArtifact({ ...finalManifest, version: ownVersion }).zip
      : zipBuffer;
  const newIntegrity = computeIntegrity(new Uint8Array(comparable));
  const latestIntegrity = await getLatestVersionIntegrity(packageId);
  if (latestIntegrity && newIntegrity === latestIntegrity) {
    // The draft IS the latest version (a revert, a save of identical bytes):
    // clear the marker, so neither the dashboard nor the CLI keeps offering a
    // publish that can only answer `no_changes`.
    await withPackageDraftLock(packageId, (tx) =>
      settleDraftAgainstLatest(tx, packageId, orgId, pkg.lockVersion),
    );
    return { error: "no_changes" };
  }

  const result = await createVersionAndUpload({
    packageId,
    version,
    createdBy: userId,
    zipBuffer,
    manifest: finalManifest,
  });
  if (!result) return { error: "invalid_version" };
  // Same version, different content (the identical-content case returned
  // `no_changes` above): refuse loudly instead of silently keeping the old
  // artifact — the caller must bump the version to publish the new content.
  if (result.outcome === "exists") return { error: "version_exists" };

  await finalizeDraftPublication({
    packageId,
    orgId,
    lockVersion: pkg.lockVersion,
    versionId: result.id,
    manifest: params.version && params.version !== baseManifest.version ? finalManifest : undefined,
  });
  return { id: result.id, version: result.version };
}

/**
 * The draft's unpublished-changes marker (`updatedAt` against the latest
 * version's `createdAt`), settled for a snapshot captured at `lockVersion`: the
 * latest version holds that snapshot, so the draft is clean — unless a save
 * landed since (the lock moved), which stays dirty even when it preceded the
 * version's creation timestamp.
 */
async function settleDraftAgainstLatest(
  tx: Parameters<Parameters<typeof withPackageDraftLock>[1]>[0],
  packageId: string,
  orgId: string,
  lockVersion: number,
): Promise<void> {
  const publishedAt = sql`(
    SELECT MAX(${packageVersions.createdAt}) FROM ${packageVersions}
    WHERE ${packageVersions.packageId} = ${packageId}
  )`;
  await tx
    .update(packages)
    .set({
      updatedAt: sql`CASE WHEN ${packages.lockVersion} = ${lockVersion}
        THEN LEAST(${packages.updatedAt}, ${publishedAt})
        ELSE GREATEST(${packages.updatedAt}, ${publishedAt} + interval '1 millisecond') END`,
    })
    .where(and(eq(packages.id, packageId), eq(packages.orgId, orgId)));
}

/** Reconcile a published snapshot with the draft without hiding concurrent edits. */
export async function finalizeDraftPublication(params: {
  packageId: string;
  orgId: string;
  lockVersion: number;
  versionId: number;
  /** A published version override, applied only while the captured draft is current. */
  manifest?: Record<string, unknown>;
}): Promise<void> {
  const { packageId, orgId, lockVersion, versionId, manifest } = params;
  await withPackageDraftLock(packageId, async (tx) => {
    const [latest] = await tx
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, packageId))
      .orderBy(desc(packageVersions.id))
      .limit(1);
    // Version inserts serialize per package. An older publish must not undo
    // the draft state finalized by a later one.
    if (latest?.id !== versionId) return;

    await settleDraftAgainstLatest(tx, packageId, orgId, lockVersion);

    // Reflect an override only in the unchanged draft, after successful publish.
    // Advance its editor token, but not updatedAt: this change is already published.
    if (manifest) {
      await tx
        .update(packages)
        .set({
          draftManifest: manifest,
          lockVersion: sql`${packages.lockVersion} + 1`,
        })
        .where(
          and(
            eq(packages.id, packageId),
            eq(packages.orgId, orgId),
            eq(packages.lockVersion, lockVersion),
          ),
        );
    }
  });
}

// ─────────────────────────────────────────────
// Replace existing version content
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// AFPS §4.3 — circular dependency detection
// ─────────────────────────────────────────────

/**
 * Resolver for {@link detectCycle}: returns the direct dependencies of the
 * latest published version of `@scope/name` from its `package_version_dependencies`
 * rows (the derived index — a per-version projection of `manifest.dependencies`,
 * direct deps only; {@link detectCycle} walks the graph transitively by calling
 * this resolver per node). Used at publish time to reject cycles before
 * persistence. The graph is a conservative snapshot — yanked versions are
 * excluded by {@link getLatestVersionId}'s preference for "latest" dist-tag.
 */
async function resolvePublishedDeps(scope: string, name: string): Promise<DepEntry[]> {
  const packageId = `${scope}/${name}`;
  const versionId = await getLatestVersionId(packageId);
  if (!versionId) return [];
  const rows = await db
    .select({
      depScope: packageVersionDependencies.depScope,
      depName: packageVersionDependencies.depName,
      depType: packageVersionDependencies.depType,
      versionRange: packageVersionDependencies.versionRange,
    })
    .from(packageVersionDependencies)
    .where(eq(packageVersionDependencies.versionId, versionId));
  return rows.map((r) => ({
    depScope: r.depScope,
    depName: r.depName,
    depType: r.depType as DepEntry["depType"],
    versionRange: r.versionRange,
  }));
}

/**
 * Walk the dep graph rooted at `packageId` with `directDeps`, rejecting any
 * cycle with a structured error carrying the cycle path. Wraps
 * {@link detectCycle} for the publish path; the self-dep fast-path (a package
 * declaring itself in its own deps) is handled by `detectCycle` directly.
 */
async function assertNoCycle(packageId: string, directDeps: DepEntry[]): Promise<void> {
  // AFPS §4.3 — circular dependency detection.
  const result = await detectCycle(packageId, directDeps, resolvePublishedDeps);
  if (result.hasCycle) {
    const path = result.cyclePath?.join(" → ") ?? packageId;
    throw new Error(`Circular dependency detected: ${path}`);
  }
}

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

  // Validate dep shape + reject cycles BEFORE uploading or mutating DB so a
  // bad manifest can't leave a partial side-effect (uploaded ZIP, stale row).
  // `extractDependencies` itself rejects invalid scoped names and invalid
  // semver ranges (invalid ranges are rejected upstream here).
  const deps = extractDependencies(manifest);
  await assertNoCycle(packageId, deps);

  // Bail before touching storage when the version row doesn't exist: the old
  // order uploaded first, so a bad `version` overwrote the artifact of... a
  // version nobody had, or worse raced a concurrent publish (#896-adjacent).
  const [existingRow] = await db
    .select({ id: packageVersions.id })
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
    .limit(1);
  if (!existingRow) {
    logger.warn("replaceVersionContent: version row not found", { packageId, version });
    return;
  }

  // Upload ZIP first to avoid integrity mismatch if upload fails after DB update
  await uploadPackageZip(packageId, version, zipBuffer);

  // Row update + dependency-index rewrite in one transaction, so the manifest
  // snapshot and its derived index can never diverge on a partial failure.
  // Invalid ranges are rejected upstream by `extractDependencies`.
  const found = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(packageVersions)
      .set({ integrity, artifactSize, manifest })
      .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
      .returning({ id: packageVersions.id });

    if (!row) return false;

    await clearVersionDependencies(row.id, tx);
    if (deps.length > 0) {
      await storeVersionDependencies(row.id, deps, tx);
    }
    return true;
  });

  if (!found) {
    logger.warn("replaceVersionContent: version row not found", { packageId, version });
    return;
  }

  logger.info("Replaced version content", { packageId, version, integrity });
}

// ─────────────────────────────────────────────
// Convenience: create version + upload ZIP
// ─────────────────────────────────────────────

/** Create a version snapshot and upload the ZIP to Storage in one call.
 *
 *  The upload happens INSIDE `createPackageVersion`'s transaction, strictly
 *  after the forward-only/exists decision (#896): an `exists` or `rejected`
 *  outcome never touches storage, so a republish of an existing version can
 *  no longer overwrite published bytes (leaving the row's stale integrity
 *  hash to fail every subsequent run) or delete a good artifact via the old
 *  upload-then-clean-up sequence. */
export async function createVersionAndUpload(params: {
  packageId: string;
  version: string;
  createdBy: string | null;
  zipBuffer: Buffer;
  manifest: Record<string, unknown>;
}): Promise<{ id: number; version: string; outcome: "created" | "exists" } | null> {
  const { packageId, version, createdBy, zipBuffer, manifest } = params;

  const integrity = computeIntegrity(new Uint8Array(zipBuffer));
  const artifactSize = zipBuffer.byteLength;

  // Validate dep shape + reject cycles BEFORE uploading or persisting the
  // version row. `extractDependencies` rejects invalid scoped names and
  // invalid semver ranges (invalid ranges are rejected upstream
  // here, so the throw propagates and no ZIP / row is created).
  const deps = extractDependencies(manifest);
  await assertNoCycle(packageId, deps);

  try {
    // The version row + its derived dependency index commit atomically inside
    // createPackageVersion's transaction; the artifact upload runs in there
    // too, only on a `created` outcome, so row and bytes commit together.
    return await createPackageVersion({
      packageId,
      version,
      integrity,
      artifactSize,
      manifest,
      createdBy,
      deps,
      uploadZip: () => uploadPackageZip(packageId, version, zipBuffer),
    });
  } catch (err) {
    // The transaction rolled back. If the upload itself went through (or
    // partially) before a later step failed, the bytes sit at a path no
    // version row references. Best-effort cleanup — but ONLY when no row
    // exists for this version: if one does, the artifact at that path is the
    // published one from an earlier publish and must not be deleted.
    try {
      const [existingRow] = await db
        .select({ id: packageVersions.id })
        .from(packageVersions)
        .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
        .limit(1);
      if (!existingRow) {
        await deleteVersionZip(packageId, version);
      }
    } catch {
      logger.warn("Failed to clean up ZIP after version create error", { packageId, version });
    }
    throw err;
  }
}
