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

import { unzipBounded, DecompressionLimitError } from "@appstrate/afps-shared/unzip-bounded";
import { BundleError } from "./errors.ts";
import { parseAfpsManifestBytes } from "./parse-manifest.ts";
import { sanitizeEntries, stripWrapperPrefix, sumSizes } from "./archive-utils.ts";
import { assertCompanionFiles } from "./companion-files.ts";
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
  type ResolvedPackage,
} from "./types.ts";

export interface BuildBundleOptions {
  metadata?: BundleMetadata;
  limits?: Partial<BundleLimits>;
  /** Called with a human-readable message for non-fatal conditions (cycles). */
  onWarn?: (msg: string) => void;
  /**
   * Which `dependencies.*` sections to walk into the bundle graph. Defaults to
   * all bundleable sections. Run-bundle builders pass `["skills"]`: an agent's
   * integrations and mcp-servers are not bundle members — they are spawned /
   * fetched separately by the sidecar at runtime — so they must not be walked
   * into (and fetched for) the agent bundle.
   */
  depTypes?: DepRequest["type"][];
}

/**
 * Walk the root's transitive dependency graph via `catalog`, dedupe by
 * identity, and return the assembled Bundle.
 *
 * Walks `manifest.dependencies.{skills, mcp_servers, integrations}` recursively.
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
  const depTypes = opts.depTypes ?? ["skills", "mcp_servers", "integrations"];
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

    const deps = extractDependencies(pkg.manifest, depTypes);

    // Resolve every direct dep in parallel — resolution is a read-only
    // catalog lookup with no inter-dep ordering requirement. Results are
    // folded back in declaration order so `missing` keeps a deterministic
    // order regardless of resolution completion order.
    const resolutions = await Promise.all(
      deps.map(({ name, versionSpec }) => catalog.resolve(name, versionSpec)),
    );

    // Dedupe synchronously against the already-loaded set AND within this
    // level (two siblings may declare the same dep), so the parallel fetch
    // below never fetches one identity twice.
    const toFetch: ResolvedPackage[] = [];
    const claimedThisLevel = new Set<PackageIdentity>();
    for (let i = 0; i < deps.length; i++) {
      const { name, versionSpec } = deps[i]!;
      const resolved = resolutions[i];
      if (!resolved) {
        missing.push({ from: pkg.identity, name, versionSpec });
        continue;
      }
      if (packages.has(resolved.identity) || claimedThisLevel.has(resolved.identity)) {
        // Already loaded — either a diamond or a cycle. If the target
        // is currently on the walk stack, it's a structural cycle.
        if (visiting.has(resolved.identity)) {
          onWarn(`cycle detected: ${pkg.identity} -> ${resolved.identity}`);
        }
        continue;
      }
      claimedThisLevel.add(resolved.identity);
      toFetch.push(resolved);
    }

    // Fetch the deduped level in parallel — fetch is read-only against the
    // catalog; all shared-state mutation (packages/visiting/missing) stays
    // in the sequential sections of this frame.
    //
    // Settle ALL fetches instead of racing on the first rejection: with
    // several broken deps, `Promise.all` surfaced whichever rejection lost
    // the I/O race, so the package named in the error changed run to run —
    // read as "the corruption moves around" by operators (#896). Failures
    // are folded back in declaration order, and integrity failures are
    // aggregated so one error names every corrupted package at once.
    const settled = await Promise.allSettled(
      toFetch.map(async (resolved) => {
        const depPkg = await catalog.fetch(resolved.identity);
        if (depPkg.identity !== resolved.identity) {
          throw new BundleError(
            "BUNDLE_JSON_INVALID",
            `catalog.fetch returned identity ${depPkg.identity} but resolve returned ${resolved.identity}`,
            { expected: resolved.identity, got: depPkg.identity },
          );
        }
        return depPkg;
      }),
    );

    const failures: Array<{ identity: PackageIdentity; reason: unknown }> = [];
    const fetched: BundlePackage[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      if (outcome.status === "fulfilled") {
        fetched.push(outcome.value);
      } else {
        failures.push({ identity: toFetch[i]!.identity, reason: outcome.reason });
      }
    }
    if (failures.length > 0) {
      const mismatches = failures.filter(
        (f) => f.reason instanceof BundleError && f.reason.code === "INTEGRITY_MISMATCH",
      );
      if (mismatches.length > 0) {
        const identities = mismatches.map((f) => f.identity);
        throw new BundleError(
          "INTEGRITY_MISMATCH",
          `Integrity check failed for ${identities.join(", ")}`,
          { packages: identities },
        );
      }
      throw failures[0]!.reason;
    }

    // Recurse sequentially (DFS) — child walks mutate the shared maps, so
    // they must not interleave. A deeper walk may have loaded a sibling's
    // identity by the time we reach it; skip it silently (diamond), warning
    // only when it is a structural cycle (still on the walk stack).
    for (const depPkg of fetched) {
      if (packages.has(depPkg.identity)) {
        if (visiting.has(depPkg.identity)) {
          onWarn(`cycle detected: ${pkg.identity} -> ${depPkg.identity}`);
        }
        continue;
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

  // Memory-bounded inflate: the decompressed-total / per-file / file-count
  // caps are enforced mid-inflate (aborts before the offending bytes
  // accumulate), so this — not the post-hoc `sumSizes` / entry-count checks
  // below — is the primary OOM boundary. See
  // `@appstrate/afps-shared/unzip-bounded`.
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipBounded(archive, {
      maxDecompressedBytes: limits.maxDecompressedBytes,
      maxFileBytes: limits.maxFileBytes,
      maxFiles: limits.maxFiles,
    });
  } catch (err) {
    if (err instanceof DecompressionLimitError) {
      throw decompressionLimitToBundleError(err, ".afps archive");
    }
    throw new BundleError(
      "ARCHIVE_INVALID",
      `failed to decompress .afps archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let entries = sanitizeEntries(raw, { limits, context: "afps" });
  entries = stripWrapperPrefix(entries);

  // Entry-count cap mirrors the multi-package bundle path (`read.ts`). Per
  // spec §8.1, archive processing MUST limit total entry count; without
  // this guard a 1M-entry `.afps` with tiny files slips through the per-file
  // and decompressed caps. Both single-package and multi-package paths now
  // enforce the same `maxFiles` ceiling.
  if (entries.size > limits.maxFiles) {
    throw new BundleError(
      "LIMITS_EXCEEDED",
      `afps archive has ${entries.size} files — exceeds limit ${limits.maxFiles}`,
      { field: "files", count: entries.size },
    );
  }

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

  const manifest = parseAfpsManifestBytes(manifestBytes) as AfpsManifest;

  // AFPS (§3.4 / §11.2) lifted the mcp-server scoped identity to the
  // manifest root, so every package type — including mcp-server — now
  // declares its `@scope/name` identity at the top-level `name`. The previous
  // `_meta["dev.afps/mcp-server"].name` slot is gone.
  const isMcpServer = manifest.type === "mcp-server";
  const rawName = typeof manifest.name === "string" ? manifest.name : undefined;
  const name = rawName ?? null;
  const version = typeof manifest.version === "string" ? manifest.version : null;
  if (!name || !version) {
    throw new BundleError(
      "BUNDLE_JSON_INVALID",
      isMcpServer
        ? `mcp-server manifest must declare a scoped root name + version (got name=${JSON.stringify(name)}, version=${JSON.stringify(version)})`
        : `manifest.json must declare name + version (got name=${JSON.stringify(name)}, version=${JSON.stringify(version)})`,
    );
  }
  if (!name.startsWith("@") || !name.includes("/")) {
    throw new BundleError(
      "BUNDLE_JSON_INVALID",
      isMcpServer
        ? `mcp-server identity name must be scoped (@scope/name), got ${name}`
        : `manifest.name must be scoped (@scope/name), got ${name}`,
    );
  }
  const identity = formatPackageIdentity(name as `@${string}/${string}`, version);

  // §3.3 / §3.4 companion-file enforcement — single source of truth shared
  // with the platform's ZIP-import path (`@appstrate/core/zip:parsePackageZip`
  // via `@appstrate/core/companion-files`). Both paths reject the same
  // inputs: agent prompt.md non-empty, skill SKILL.md + frontmatter name,
  // mcp-server server.entry_point payload present.
  assertCompanionFiles(
    manifest as { type?: unknown; server?: unknown } & Record<string, unknown>,
    entries,
  );

  // Compute per-package integrity over the RECORD.
  const recordBody = serializeRecord(computeRecordEntries(entries));
  const integrity = recordIntegrity(recordBody);

  return { identity, manifest, files: entries, integrity };
}

interface DepRequest {
  name: string;
  versionSpec: string;
  type: "skills" | "mcp_servers" | "integrations";
}

function extractDependencies(manifest: AfpsManifest, depTypes: DepRequest["type"][]): DepRequest[] {
  const out: DepRequest[] = [];
  const deps = manifest.dependencies;
  if (!deps || typeof deps !== "object") return out;
  const depsObj = deps as Record<string, unknown>;

  for (const type of depTypes) {
    const section = depsObj[type];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    for (const [name, spec] of Object.entries(section as Record<string, unknown>)) {
      // AFPS §4.1 — each dependency value is a bare semver range string.
      // Per-integration configuration (`tools`/`scopes`/`auth_key`) lives in
      // the top-level `integrations_configuration` map and is consumed
      // downstream by `parseManifestIntegrations` against the same manifest.
      if (typeof spec !== "string") continue;
      out.push({ name, versionSpec: spec, type });
    }
  }
  return out;
}

/**
 * Map a mid-inflate {@link DecompressionLimitError} onto the {@link BundleError}
 * shape this builder already throws. A `corrupt-archive` reason surfaces as
 * `ARCHIVE_INVALID` (matching the previous decompress-failure branch); the
 * three resource-budget reasons surface as `LIMITS_EXCEEDED` with a `field`
 * mirroring the post-hoc checks they replace.
 */
function decompressionLimitToBundleError(
  err: DecompressionLimitError,
  context: string,
): BundleError {
  if (err.reason === "corrupt-archive") {
    return new BundleError("ARCHIVE_INVALID", `failed to decompress ${context}: ${err.message}`);
  }
  const field =
    err.reason === "too-many-files"
      ? "files"
      : err.reason === "file-too-large"
        ? "fileBytes"
        : "decompressedBytes";
  return new BundleError("LIMITS_EXCEEDED", err.message, { field });
}
