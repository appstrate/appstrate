import { join } from "node:path";
import { logger } from "../lib/logger.ts";
import { loadSystemPackages, type SystemPackageEntry } from "@appstrate/core/system-packages";
import type { PackageType } from "./package-items/config.ts";

export type { SystemPackageEntry };

export const BUILTIN_SCOPE = "appstrate";

/** System packages dir: ZIPs live alongside the API source. */
const SYSTEM_PACKAGES_DIR = join(import.meta.dir, "../../../../system-packages");

let systemPackages: ReadonlyMap<string, SystemPackageEntry> = new Map();

/** Load system packages from ZIPs. Call once at boot. */
export async function initSystemPackages(): Promise<void> {
  const result = await loadSystemPackages(SYSTEM_PACKAGES_DIR);

  for (const w of result.warnings) {
    logger.warn("System package ZIP invalid — skipping", { file: w.file, error: w.error });
  }

  const pkgMap = new Map<string, SystemPackageEntry>();
  for (const entry of result.packages) {
    pkgMap.set(entry.packageId, entry);
    logger.debug("System package loaded from ZIP", {
      id: entry.packageId,
      type: entry.type,
      version: entry.version,
    });
  }
  systemPackages = pkgMap;

  logger.info("System packages loaded", {
    total: pkgMap.size,
    packageIds: [...pkgMap.keys()],
  });
}

// ─── Generic system package accessors ───

export function getSystemPackages(): ReadonlyMap<string, SystemPackageEntry> {
  return systemPackages;
}

export function isSystemPackage(id: string): boolean {
  return systemPackages.has(id);
}

export function getSystemPackageEntry(id: string): SystemPackageEntry | undefined {
  return systemPackages.get(id);
}

export function getSystemPackagesByType(type: PackageType): SystemPackageEntry[] {
  return [...systemPackages.values()].filter((e) => e.type === type);
}
