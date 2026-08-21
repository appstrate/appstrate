// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { loadSystemPackages, type SystemPackageEntry } from "@appstrate/core/system-packages";
import { compareVersionsDesc } from "@appstrate/core/semver";
import { getErrorMessage } from "@appstrate/core/errors";
import { computeIntegrity } from "@appstrate/core/integrity";
import { createVersionAndUpload } from "./package-versions.ts";
import { uploadPackageFiles, SYSTEM_STORAGE_NAMESPACE } from "./package-items/storage.ts";
import { storageFolderForType } from "./package-items/config.ts";

export type { SystemPackageEntry };

/** What one `syncSystemPackagesToDb` pass actually wrote. */
interface SystemPackageSyncReport {
  /** `packages` rows inserted or updated. */
  syncedPackages: number;
  /** `package_versions` rows created. */
  syncedVersions: number;
  /** Canonical packages already persisted from byte-identical archives. */
  unchangedPackages: number;
  /** Versions already registered from byte-identical archives. */
  unchangedVersions: number;
}

/** System packages dir: AFPS packages live alongside the API source. */
const SYSTEM_PACKAGES_DIR = join(import.meta.dir, "../../../../system-packages");

// Canonical entry per packageId (highest semver). Drives `packages.draftManifest`,
// `isSystemPackage()` lookups, and the public package-list UI.
let systemPackages: ReadonlyMap<string, SystemPackageEntry> = new Map();
// Every loaded version, all packages combined. The boot sync iterates this list
// to register each version in `package_versions` so semver ranges like `^1.0.0`
// resolve correctly even when a newer major has shipped.
let systemPackageVersions: readonly SystemPackageEntry[] = [];

/**
 * Max concurrent DB round-trips issued by the boot sync. The postgres.js pool
 * is `max: 20` and boot is not the only thing holding connections, so an
 * unbounded `Promise.all` over ~66 packages × 2 passes would queue every
 * caller behind the pool. Kept well under the pool size on purpose.
 */
const SYNC_CONCURRENCY = 6;

/**
 * `Promise.all`-shaped map with a bounded worker pool. Local by design: this
 * file and `lib/boot.ts` each keep their own tiny pool rather than sharing a
 * new util module.
 */
async function mapBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Load system packages from AFPS archives. Call once at boot. */
export async function initSystemPackages(): Promise<void> {
  const result = await loadSystemPackages(SYSTEM_PACKAGES_DIR);

  for (const w of result.warnings) {
    logger.warn("System package invalid — skipping", { file: w.file, error: w.error });
  }

  // Pick the highest semver per packageId as canonical. Filesystem readdir
  // order is platform-dependent, so a Map.set race over multi-version
  // packages would otherwise yield a non-deterministic canonical version.
  const pkgMap = new Map<string, SystemPackageEntry>();
  for (const entry of result.packages) {
    const current = pkgMap.get(entry.packageId);
    if (!current || compareVersionsDesc(entry.version, current.version) < 0) {
      pkgMap.set(entry.packageId, entry);
    }
    logger.debug("System package loaded", {
      id: entry.packageId,
      type: entry.type,
      version: entry.version,
    });
  }
  systemPackages = pkgMap;
  systemPackageVersions = result.packages;

  logger.info("System packages loaded", {
    total: pkgMap.size,
    versions: result.packages.length,
    packageIds: [...pkgMap.keys()],
  });
}

// ─── Generic system package accessors ───

export function getSystemPackages(): ReadonlyMap<string, SystemPackageEntry> {
  return systemPackages;
}

/** Every loaded entry across all versions — read by `syncSystemPackagesToDb` to register each in `package_versions`. */
function getAllSystemPackageVersions(): readonly SystemPackageEntry[] {
  return systemPackageVersions;
}

export function isSystemPackage(id: string): boolean {
  return systemPackages.has(id);
}

/**
 * Sync the already-loaded system-package registry to the DB. Public so
 * integration tests can drive it independently of `initSystemPackages`
 * (which reads from disk) — production calls it with no args and it reads
 * the module-state registry; tests pass fixtures directly via the optional
 * `canonical` / `versions` params, then assert the resulting DB state.
 *
 * - UPSERT one `packages` row per packageId at the canonical (highest semver) version
 * - Register every loaded version in `package_versions` (idempotent)
 * - Refuse-overwrite on integrity drift without a version bump (the safety gate)
 *
 * Returns what it did. A boot over an unchanged package set must report zero
 * writes — that is the contract the content-addressed skip guards below exist
 * to keep, and what the sync test asserts.
 */
export async function syncSystemPackagesToDb(
  canonical?: ReadonlyMap<string, SystemPackageEntry>,
  versions?: readonly SystemPackageEntry[],
): Promise<SystemPackageSyncReport> {
  const canonicalPackages = canonical ?? getSystemPackages();
  const allVersions = versions ?? getAllSystemPackageVersions();
  if (canonicalPackages.size === 0) {
    return { syncedPackages: 0, syncedVersions: 0, unchangedPackages: 0, unchangedVersions: 0 };
  }

  let syncedPackages = 0;
  let syncedVersions = 0;
  let unchangedPackages = 0;
  let unchangedVersions = 0;

  // One SHA-256 per loaded archive, shared by both passes below (the canonical
  // pass and the version pass hash the same `zipBuffer` for the canonical
  // entry). Keyed by entry identity — the canonical map holds the very same
  // objects as `allVersions`.
  const integrityCache = new Map<SystemPackageEntry, string>();
  const integrityOf = (entry: SystemPackageEntry): string => {
    let value = integrityCache.get(entry);
    if (value === undefined) {
      value = computeIntegrity(new Uint8Array(entry.zipBuffer));
      integrityCache.set(entry, value);
    }
    return value;
  };

  // Step 1 — UPSERT one `packages` row per packageId, using the canonical
  // (highest semver) version. This drives `draftManifest`/`draftContent`,
  // file uploads, and the public package-list UI.
  const syncCanonical = async (id: string, entry: SystemPackageEntry) => {
    const { manifest, type, version } = entry;
    const freshIntegrity = integrityOf(entry);

    // Single read that answers both questions the write below depends on:
    // is this canonical version already registered (drives `updatedAt`), and
    // is the `packages` row already in the shape we would write?
    //
    // INNER JOIN on purpose: `package_versions.package_id` is ON DELETE
    // CASCADE, so a missing `packages` row means its version rows are gone
    // too — no match, and the branch falls through to the full UPSERT.
    const [existingVersion] = await db
      .select({
        integrity: packageVersions.integrity,
        packageType: packages.type,
        packageSource: packages.source,
        packageOrgId: packages.orgId,
      })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .where(and(eq(packageVersions.packageId, id), eq(packageVersions.version, version)))
      .limit(1);

    // `updatedAt` is bumped only when this canonical version is genuinely
    // new — re-boots over an unchanged set must remain side-effect-free
    // for downstream consumers that watch `updatedAt`.
    const isNewVersion = !existingVersion;

    // Skip guard. `.afps` archives are content-addressed by `integrity`
    // (SHA-256 over the archive bytes), so a matching hash means
    // `draftManifest` / `draftContent` / `files` were all derived from the
    // exact same bytes already persisted — there is nothing to write, and
    // nothing to re-upload. The row's identity columns are compared too so a
    // drifted `type` / `source` / `orgId` still heals in place. Without this,
    // every boot re-ran 66 UPSERTs (plus an S3 re-upload) to write back
    // byte-identical values.
    //
    // CONSEQUENCE, and it is the price of content-addressing: the archive
    // bytes become the ONLY thing that can invalidate the persisted row. A
    // change to how this package DERIVES `manifest` / `content` / `files`
    // from unchanged bytes (a loader or normalization fix in
    // `@appstrate/core/system-packages`) is therefore NOT picked up by a
    // redeploy — the hash still matches and the stale derivation survives.
    // Shipping such a change means bumping the affected system packages'
    // versions, exactly as issue #928 concluded. Do not "fix" this by
    // dropping the guard; every boot would go back to 594 no-op round trips.
    if (
      existingVersion &&
      existingVersion.integrity === freshIntegrity &&
      existingVersion.packageType === type &&
      existingVersion.packageSource === "system" &&
      existingVersion.packageOrgId === null
    ) {
      unchangedPackages++;
      return;
    }

    await db
      .insert(packages)
      .values({
        id,
        orgId: null,
        type,
        source: "system",
        draftManifest: manifest as unknown as Record<string, unknown>,
        draftContent: entry.content,
      })
      .onConflictDoUpdate({
        target: packages.id,
        set: {
          // `type` must heal in place: a packageId can change type across
          // versions, so a reseed updates it rather than keeping the stale
          // value (which would drop the row out of its catalogue list).
          type,
          draftManifest: manifest as unknown as Record<string, unknown>,
          draftContent: entry.content,
          source: "system",
          orgId: null,
          ...(isNewVersion ? { updatedAt: new Date() } : {}),
        },
      });

    if (Object.keys(entry.files).length > 1) {
      await uploadPackageFiles(
        storageFolderForType(type),
        SYSTEM_STORAGE_NAMESPACE,
        id,
        entry.files,
      );
    }

    syncedPackages++;
  };

  // Step 2 — register every loaded version in `package_versions` so semver
  // ranges (e.g. `^1.0.0`) keep resolving when a newer major ships
  // alongside the legacy line. createVersionAndUpload is idempotent
  // (skip-if-exists).
  //
  // Published versions are immutable. `zipArtifact` produces reproducible
  // bytes, so a source rebuilt at the same version yields the same integrity
  // hash — any drift from the stored row therefore means the source content
  // changed without a version bump (a developer mistake), not rebuild noise.
  // We refuse to overwrite the published bytes and log an actionable error
  // instead; the previously-loaded version stays authoritative until the
  // version is bumped.
  const syncVersion = async (entry: SystemPackageEntry) => {
    const freshIntegrity = integrityOf(entry);

    const [existing] = await db
      .select({ integrity: packageVersions.integrity })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, entry.packageId),
          eq(packageVersions.version, entry.version),
        ),
      )
      .limit(1);

    // Already registered with byte-identical content: nothing to do. Calling
    // `createVersionAndUpload` here would walk the dependency graph (a read per
    // dep) and open a transaction that takes a per-package advisory lock only
    // to discover the version exists and log "Version already exists" — 66
    // no-op transactions per boot.
    if (existing && existing.integrity === freshIntegrity) {
      unchangedVersions++;
      return;
    }

    if (existing) {
      logger.error(
        "System package content changed without a version bump — refusing to " +
          "overwrite a published, immutable version. Bump the version in the " +
          "source manifest; the previously-loaded bytes remain authoritative.",
        {
          packageId: entry.packageId,
          version: entry.version,
          dbIntegrity: existing.integrity,
          sourceIntegrity: freshIntegrity,
        },
      );
      return;
    }

    await createVersionAndUpload({
      packageId: entry.packageId,
      version: entry.version,
      createdBy: null,
      zipBuffer: entry.zipBuffer,
      manifest: entry.manifest as unknown as Record<string, unknown>,
    });
    syncedVersions++;
  };

  await mapBounded(Array.from(canonicalPackages), SYNC_CONCURRENCY, ([id, entry]) =>
    syncCanonical(id, entry).catch((err) => {
      logger.warn("Failed to sync canonical system package", {
        packageId: id,
        error: getErrorMessage(err),
      });
    }),
  );
  await mapBounded(allVersions, SYNC_CONCURRENCY, (entry) =>
    syncVersion(entry).catch((err) => {
      logger.warn("Failed to register system package version", {
        packageId: entry.packageId,
        version: entry.version,
        error: getErrorMessage(err),
      });
    }),
  );

  logger.info("System packages synced", {
    packages: syncedPackages,
    versions: syncedVersions,
    unchangedPackages,
    unchangedVersions,
  });

  return { syncedPackages, syncedVersions, unchangedPackages, unchangedVersions };
}
