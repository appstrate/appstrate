// SPDX-License-Identifier: Apache-2.0

/**
 * Load the built system-package archives and classify each by behavioural
 * class (see `PackageClass`). Reads the shipped `.afps` artifacts — the same
 * bytes loaded at boot — via `loadSystemPackages`, so the harness tests what
 * actually ships, not the loose source tree.
 */

import { loadSystemPackages, type SystemPackageEntry } from "@appstrate/core/system-packages";
import type { PackageClass } from "./types.ts";

export interface ClassifiedPackage {
  entry: SystemPackageEntry;
  klass: PackageClass;
}

/** Read `source.kind` from a raw manifest, tolerating missing/foreign shapes. */
function sourceKind(manifest: Record<string, unknown>): string | undefined {
  const source = manifest.source;
  if (source && typeof source === "object") {
    const kind = (source as { kind?: unknown }).kind;
    if (typeof kind === "string") return kind;
  }
  return undefined;
}

/** Map a loaded package to its behavioural class. */
export function classify(entry: SystemPackageEntry): PackageClass {
  if (entry.type === "mcp-server") return "mcp-server-local";
  if (entry.type === "integration") {
    return sourceKind(entry.manifest) === "remote" ? "mcp-remote" : "integration-cred";
  }
  return "other";
}

/**
 * Load + classify every archive in `dir`. Unreadable archives surface as
 * `warnings` (propagated by the caller as failures).
 */
export async function loadClassified(dir: string): Promise<{
  packages: ClassifiedPackage[];
  warnings: Array<{ file: string; error: string }>;
}> {
  const { packages, warnings } = await loadSystemPackages(dir);
  return {
    packages: packages.map((entry) => ({ entry, klass: classify(entry) })),
    warnings,
  };
}
