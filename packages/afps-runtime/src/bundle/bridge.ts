// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Backward-compat adapters between the legacy single-package
 * {@link LoadedBundle} surface and the new multi-package {@link Bundle}.
 *
 * The legacy surface will be removed once all consumers (runner-pi,
 * resolvers, CLI, platform routes) migrate to the new types. This
 * module is the one place to look when you need to go one way or the
 * other during the transition.
 */

import { extractRootFromAfps } from "./build.ts";
import { buildBundleFromCatalog } from "./build.ts";
import { emptyPackageCatalog } from "./catalog.ts";
import type { LoadedBundle } from "./loader.ts";
import { computeRecordEntries, recordIntegrity, serializeRecord } from "./integrity.ts";
import { BUNDLE_FORMAT_VERSION, formatPackageIdentity } from "./types.ts";
import type { Bundle, BundlePackage, PackageIdentity } from "./types.ts";
import { bundleIntegrity } from "./integrity.ts";
import { BundleError } from "./errors.ts";

/**
 * Convert a legacy {@link LoadedBundle} (single AFPS package, possibly
 * with manifest + prompt + files) into a new {@link Bundle} of 1.
 * Used during the Phase 1 migration — callers already holding a
 * LoadedBundle can upgrade without re-reading the archive.
 */
export function loadedBundleToBundle(legacy: LoadedBundle): Bundle {
  const manifest = legacy.manifest as Record<string, unknown>;
  const name = typeof manifest.name === "string" ? manifest.name : null;
  const version = typeof manifest.version === "string" ? manifest.version : null;
  if (!name || !version) {
    throw new BundleError(
      "BUNDLE_JSON_INVALID",
      "loadedBundleToBundle: manifest missing name/version",
    );
  }
  if (!name.startsWith("@") || !name.includes("/")) {
    throw new BundleError(
      "BUNDLE_JSON_INVALID",
      `loadedBundleToBundle: manifest.name must be scoped, got ${name}`,
    );
  }
  const identity = formatPackageIdentity(name as `@${string}/${string}`, version);

  const files = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(legacy.files)) files.set(path, data);

  const recordBody = serializeRecord(computeRecordEntries(files));
  const integrity = recordIntegrity(recordBody);
  const pkg: BundlePackage = { identity, manifest, files, integrity };

  const pkgIndex = new Map<PackageIdentity, { path: string; integrity: string }>();
  const parsedScope = identity.slice(1).split("/");
  const [scope, rest] = parsedScope;
  const pkgName = rest?.split("@")[0] ?? "";
  pkgIndex.set(identity, {
    path: `packages/@${scope}/${pkgName}/${version}/`,
    integrity,
  });

  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: identity,
    packages: new Map([[identity, pkg]]),
    integrity: bundleIntegrity(pkgIndex),
  };
}

/**
 * Build a new-format `Bundle` of 1 from raw AFPS ZIP bytes — the
 * preferred migration path for callers that currently decode AFPS ZIPs
 * into a legacy `LoadedBundle`.
 */
export async function bundleOfOneFromAfps(archive: Uint8Array): Promise<Bundle> {
  const root = extractRootFromAfps(archive);
  return buildBundleFromCatalog(root, emptyPackageCatalog);
}
