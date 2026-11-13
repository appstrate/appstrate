// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { isRuntimeBoundIntegration } from "@appstrate/core/integration";
import { loadSystemPackages, type SystemPackageEntry } from "@appstrate/core/system-packages";
import {
  _setSystemPackagesForTesting,
  syncSystemPackagesToDb,
} from "../../src/services/system-packages.ts";

const SYSTEM_PACKAGES_DIR = join(import.meta.dir, "../../../../system-packages");

let shipped: Promise<SystemPackageEntry[]> | null = null;

/** The shipped archives of the integrations bound to the runtime, read once per process. */
function loadRuntimeBoundEntries(): Promise<SystemPackageEntry[]> {
  shipped ??= loadSystemPackages(SYSTEM_PACKAGES_DIR).then(({ packages }) =>
    packages.filter(
      (entry) => entry.type === "integration" && isRuntimeBoundIntegration(entry.manifest),
    ),
  );
  return shipped;
}

/**
 * Give the test app the system integrations bound to the runtime, as `boot()`
 * gives production: the registry entry (activation without a space row) and
 * the `packages` / `package_versions` rows the run's dependency resolution
 * reads. A default inline manifest declares `@appstrate/platform`, so every
 * test that launches one needs it.
 *
 * Call after `truncateAll()` (which deletes the rows) and call the returned
 * undo once the test's run pipeline has settled: `bun test` runs every file
 * in one process, and a registry left populated would change
 * `isSystemPackage()` for the files that run after.
 */
export async function installRuntimeBoundSystemPackages(): Promise<() => void> {
  const entries = await loadRuntimeBoundEntries();
  const canonical = new Map(entries.map((entry) => [entry.packageId, entry]));
  const restore = _setSystemPackagesForTesting(canonical);
  await syncSystemPackagesToDb(canonical, entries);
  return restore;
}
