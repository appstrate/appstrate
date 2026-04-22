// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Bundle builders.
 *
 * - {@link buildBundleFromCatalog}: core primitive — walk root's deps via
 *   the provided {@link PackageCatalog}, dedupe by identity, return a
 *   fully-populated {@link Bundle}.
 * - {@link buildBundleFromAfps}: convenience — ingest a raw AFPS `.afps`
 *   archive as the root package, then delegate.
 *
 * These are the only paths from *any* source (DB, workspace, cache,
 * registry, inline payload) to a runnable `Bundle`. Every ingestion
 * boundary in the ecosystem goes through here, so there is one semantic
 * for dep resolution and one set of tests.
 */

import { unzipSync } from "fflate";
import { BundleError } from "./errors.ts";
import { sanitizeEntries, stripWrapperPrefix, sumSizes } from "./archive-utils.ts";
import { resolveBundleLimits, type BundleLimits } from "./limits.ts";
import {
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
} from "./integrity.ts";
import {
  BUNDLE_FORMAT_VERSION,
  formatPackageIdentity,
  parsePackageIdentity,
  type AfpsManifest,
  type Bundle,
  type BundleMetadata,
  type BundlePackage,
  type PackageCatalog,
  type PackageIdentity,
} from "./types.ts";

export interface BuildBundleOptions {
  metadata?: BundleMetadata;
  limits?: Partial<BundleLimits>;
  /** Called with a human-readable message for non-fatal conditions (cycles). */
  onWarn?: (msg: string) => void;
}

/**
 * Walk the root's transitive dependency graph via `catalog`, dedupe by
 * identity, and return the assembled Bundle.
 *
 * Walks `manifest.dependencies.{skills, tools, providers}` recursively.
 * Cycles are tolerated (each identity is fetched once); the caller gets
 * a warning via `opts.onWarn`. Dep resolution failures are collected
 * and surfaced as a single `DEPENDENCY_UNRESOLVED` with `details.missing`.
 */
export async function buildBundleFromCatalog(
  root: BundlePackage,
  catalog: PackageCatalog,
  opts: BuildBundleOptions = {},
): Promise<Bundle> {
  const limits = resolveBundleLimits(opts.limits);
  const onWarn = opts.onWarn ?? (() => {});
  const packages = new Map<PackageIdentity, BundlePackage>();
  const visiting = new Set<PackageIdentity>();
  const missing: Array<{ from: PackageIdentity; name: string; versionSpec: string }> = [];

  async function walk(pkg: BundlePackage): Promise<void> {
    if (packages.has(pkg.identity)) {
      onWarn(`cycle detected at ${pkg.identity}`);
      return;
    }
    if (visiting.has(pkg.identity)) {
      // Re-entrance during walk = structural cycle.
      onWarn(`cycle detected at ${pkg.identity}`);
      return;
    }
    visiting.add(pkg.identity);

    packages.set(pkg.identity, pkg);

    if (packages.size > limits.maxPackages) {
      throw new BundleError(
        "LIMITS_EXCEEDED",
        `bundle graph has more than ${limits.maxPackages} packages`,
        { field: "packages", count: packages.size },
      );
    }

    const deps = extractDependencies(pkg.manifest);
    for (const { name, versionSpec } of deps) {
      const resolved = await catalog.resolve(name, versionSpec);
      if (!resolved) {
        missing.push({ from: pkg.identity, name, versionSpec });
        continue;
      }
      if (packages.has(resolved.identity)) {
        // Already loaded — either a diamond or a cycle. If the target
        // is currently on the walk stack, it's a structural cycle.
        if (visiting.has(resolved.identity)) {
          onWarn(`cycle detected: ${pkg.identity} -> ${resolved.identity}`);
        }
        continue;
      }
      const depPkg = await catalog.fetch(resolved.identity);
      if (depPkg.identity !== resolved.identity) {
        throw new BundleError(
          "BUNDLE_JSON_INVALID",
          `catalog.fetch returned identity ${depPkg.identity} but resolve returned ${resolved.identity}`,
          { expected: resolved.identity, got: depPkg.identity },
        );
      }
      await walk(depPkg);
    }

    visiting.delete(pkg.identity);
  }

  await walk(root);

  if (missing.length > 0) {
    throw new BundleError(
      "DEPENDENCY_UNRESOLVED",
      `bundle graph has ${missing.length} unresolved dependency(ies)`,
      { missing },
    );
  }

  // Compute per-package integrity (from RECORD) and bundle-level
  // integrity. We do this here rather than trust incoming BundlePackage
  // integrity strings, because catalogs of differing provenance might
  // compute RECORDs differently — builder is authoritative.
  const pkgIndex = new Map<PackageIdentity, { path: string; integrity: string }>();
  const rebuilt = new Map<PackageIdentity, BundlePackage>();
  for (const [identity, pkg] of packages) {
    const parsed = parsePackageIdentity(identity);
    if (!parsed) {
      throw new BundleError("BUNDLE_JSON_INVALID", `invalid identity ${identity}`);
    }
    const recordBody = serializeRecord(computeRecordEntries(pkg.files));
    const integrity = recordIntegrity(recordBody);
    const path = `packages/@${parsed.scope}/${parsed.name}/${parsed.version}/`;
    pkgIndex.set(identity, { path, integrity });
    rebuilt.set(identity, { ...pkg, integrity });
  }

  const computedBundleIntegrity = bundleIntegrity(pkgIndex);

  return {
    bundleFormatVersion: BUNDLE_FORMAT_VERSION,
    root: root.identity,
    packages: rebuilt,
    integrity: computedBundleIntegrity,
    metadata: opts.metadata,
  };
}

/**
 * Build a Bundle by treating a raw AFPS `.afps` archive as the root
 * package, then resolving its declared dependencies via `catalog`.
 *
 * This is the single ingestion path for the platform package import,
 * CLI offline load, and GitHub Action checkout. Same conversion, same
 * tests, same bug-fix surface.
 */
export async function buildBundleFromAfps(
  archive: Uint8Array,
  catalog: PackageCatalog,
  opts: BuildBundleOptions = {},
): Promise<Bundle> {
  const root = extractRootFromAfps(archive, opts.limits);
  return buildBundleFromCatalog(root, catalog, opts);
}

/**
 * Extract a root {@link BundlePackage} from an AFPS single-package
 * archive. Does no dep walking — pair with {@link buildBundleFromCatalog}
 * if dep resolution is needed.
 */
export function extractRootFromAfps(
  archive: Uint8Array,
  limitOverrides?: Partial<BundleLimits>,
): BundlePackage {
  const limits = resolveBundleLimits(limitOverrides);

  if (archive.length > limits.maxCompressedBytes) {
    throw new BundleError(
      "LIMITS_EXCEEDED",
      `afps archive (${archive.length} bytes) exceeds compressed limit ${limits.maxCompressedBytes}`,
      { field: "compressedBytes", bytes: archive.length },
    );
  }

  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(archive);
  } catch (err) {
    throw new BundleError(
      "ARCHIVE_INVALID",
      `failed to decompress .afps archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let entries = sanitizeEntries(raw, { limits, context: "afps" });
  entries = stripWrapperPrefix(entries);

  const decompressed = sumSizes(entries);
  if (decompressed > limits.maxDecompressedBytes) {
    throw new BundleError(
      "LIMITS_EXCEEDED",
      `decompressed afps (${decompressed} bytes) exceeds limit ${limits.maxDecompressedBytes}`,
      { field: "decompressedBytes", bytes: decompressed },
    );
  }

  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes) {
    throw new BundleError("BUNDLE_JSON_INVALID", ".afps archive missing manifest.json at root");
  }

  let manifest: AfpsManifest;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("manifest.json must be a JSON object");
    }
    manifest = parsed as AfpsManifest;
  } catch (err) {
    throw new BundleError(
      "BUNDLE_JSON_INVALID",
      `manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const name = typeof manifest.name === "string" ? manifest.name : null;
  const version = typeof manifest.version === "string" ? manifest.version : null;
  if (!name || !version) {
    throw new BundleError(
      "BUNDLE_JSON_INVALID",
      `manifest.json must declare name + version (got name=${JSON.stringify(name)}, version=${JSON.stringify(version)})`,
    );
  }
  if (!name.startsWith("@") || !name.includes("/")) {
    throw new BundleError(
      "BUNDLE_JSON_INVALID",
      `manifest.name must be scoped (@scope/name), got ${name}`,
    );
  }
  const identity = formatPackageIdentity(name as `@${string}/${string}`, version);

  // Compute per-package integrity over the RECORD.
  const recordBody = serializeRecord(computeRecordEntries(entries));
  const integrity = recordIntegrity(recordBody);

  return { identity, manifest, files: entries, integrity };
}

interface DepRequest {
  name: string;
  versionSpec: string;
  type: "skills" | "tools" | "providers";
}

function extractDependencies(manifest: AfpsManifest): DepRequest[] {
  const out: DepRequest[] = [];
  const deps = manifest.dependencies;
  if (!deps || typeof deps !== "object") return out;
  const depsObj = deps as Record<string, unknown>;

  for (const type of ["skills", "tools", "providers"] as const) {
    const section = depsObj[type];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    for (const [name, spec] of Object.entries(section as Record<string, unknown>)) {
      if (typeof spec !== "string") continue;
      out.push({ name, versionSpec: spec, type });
    }
  }
  return out;
}
