// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { logger } from "../lib/logger.ts";
import { loadSystemPackages, type SystemPackageEntry } from "@appstrate/core/system-packages";
import { compareVersionsDesc } from "@appstrate/core/semver";
import type { PackageType } from "@appstrate/core/validation";

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

/** Every loaded entry across all versions — used by the boot sync to register each in `package_versions`. */
export function getAllSystemPackageVersions(): readonly SystemPackageEntry[] {
  return systemPackageVersions;
}

export function isSystemPackage(id: string): boolean {
  return systemPackages.has(id);
}

export function getSystemPackagesByType(type: PackageType): SystemPackageEntry[] {
  return [...systemPackages.values()].filter((e) => e.type === type);
}
