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
import type { PackageType } from "@appstrate/core/validation";
import { createVersionAndUpload } from "./package-versions.ts";
import { uploadPackageFiles, SYSTEM_STORAGE_NAMESPACE } from "./package-items/storage.ts";
import { storageFolderForType } from "./package-items/config.ts";

export type { SystemPackageEntry };

/** System packages dir: AFPS packages live alongside the API source. */
const SYSTEM_PACKAGES_DIR = join(import.meta.dir, "../../../../system-packages");

// Canonical entry per packageId (highest semver). Drives `packages.draftManifest`,
// `isSystemPackage()` lookups, and the public package-list UI.
let systemPackages: ReadonlyMap<string, SystemPackageEntry> = new Map();
// Every loaded version, all packages combined. The boot sync iterates this list
// to register each version in `package_versions` so semver ranges like `^1.0.0`
// resolve correctly even when a newer major has shipped.
let systemPackageVersions: readonly SystemPackageEntry[] = [];

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

export function getSystemPackagesByType(type: PackageType): SystemPackageEntry[] {
  return [...systemPackages.values()].filter((e) => e.type === type);
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
 */
export async function syncSystemPackagesToDb(
  canonical?: ReadonlyMap<string, SystemPackageEntry>,
  versions?: readonly SystemPackageEntry[],
): Promise<void> {
  const canonicalPackages = canonical ?? getSystemPackages();
  const allVersions = versions ?? getAllSystemPackageVersions();
  if (canonicalPackages.size === 0) return;

  let syncedPackages = 0;
  let syncedVersions = 0;

  // Step 1 — UPSERT one `packages` row per packageId, using the canonical
  // (highest semver) version. This drives `draftManifest`/`draftContent`,
  // file uploads, and the public package-list UI.
  const syncCanonical = async (id: string, entry: SystemPackageEntry) => {
    const { manifest, type, version } = entry;

    // `updatedAt` is bumped only when this canonical version is genuinely
    // new — re-boots over an unchanged set must remain side-effect-free
    // for downstream consumers that watch `updatedAt`.
    const [existingVersion] = await db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, id), eq(packageVersions.version, version)))
      .limit(1);
    const isNewVersion = !existingVersion;

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
    const freshIntegrity = computeIntegrity(new Uint8Array(entry.zipBuffer));

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

    if (existing && existing.integrity !== freshIntegrity) {
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

  await Promise.all(
    Array.from(canonicalPackages).map(([id, entry]) =>
      syncCanonical(id, entry).catch((err) => {
        logger.warn("Failed to sync canonical system package", {
          packageId: id,
          error: getErrorMessage(err),
        });
      }),
    ),
  );
  await Promise.all(
    allVersions.map((entry) =>
      syncVersion(entry).catch((err) => {
        logger.warn("Failed to register system package version", {
          packageId: entry.packageId,
          version: entry.version,
          error: getErrorMessage(err),
        });
      }),
    ),
  );

  logger.info("System packages synced", {
    packages: syncedPackages,
    versions: syncedVersions,
  });
}
