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
import { BUNDLE_FORMAT_VERSION, formatPackageIdentity, parsePackageIdentity } from "./types.ts";
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

/**
 * Virtual-path adapter: project a multi-package {@link Bundle} onto the
 * legacy flat {@link LoadedBundle} surface that resolvers + `prepareBundleForPi`
 * consume today.
 *
 * Layout produced:
 *   - root package files go to the top level (manifest.json, prompt.md, …)
 *   - each non-root package's files go under `<type>/<packageId>/…`
 *     where `type ∈ {tool, skill, provider}` comes from the package's
 *     manifest, and `packageId` is the scoped name (e.g. `@appstrate/report`)
 *
 * This matches the paths hardcoded by:
 *   - `bundled-tool-resolver.ts`       → `tools/<id>/index.{mjs,js,ts}`
 *   - `bundled-skill-resolver.ts`      → `skills/<id>/SKILL.md`
 *   - `sidecar-provider-resolver.ts`   → `providers/<id>/provider.json`
 *   - `runner-pi/bundle-extensions.ts` → iterates `tools/<id>/*`, `skills/*`, `providers/*`
 *
 * Unknown package types are skipped (not an error — lets a Bundle carry
 * future package kinds without breaking the adapter). `RECORD` files are
 * stripped (runtime metadata, not part of the executable surface).
 *
 * Contract: the returned `LoadedBundle` is a READ-ONLY view — mutating
 * its `files` record has no effect on the source Bundle.
 */
export function bundleToLoadedBundle(bundle: Bundle): LoadedBundle {
  const rootPkg = bundle.packages.get(bundle.root);
  if (!rootPkg) {
    throw new BundleError(
      "BUNDLE_JSON_INVALID",
      `bundleToLoadedBundle: root ${bundle.root} not present in packages map`,
    );
  }

  const files: Record<string, Uint8Array> = {};
  let decompressedSize = 0;

  // Root package files flattened to the top level.
  for (const [p, bytes] of rootPkg.files) {
    if (p === "RECORD") continue;
    files[p] = bytes;
    decompressedSize += bytes.byteLength;
  }

  // Dependency packages laid out under their type prefix, keyed by
  // scoped id so resolver lookups match `dependencies.<type>.<id>`.
  for (const [identity, pkg] of bundle.packages) {
    if (identity === bundle.root) continue;
    const parsed = parsePackageIdentity(identity);
    if (!parsed) continue;
    const manifestType = (pkg.manifest as { type?: unknown }).type;
    const prefix = prefixForType(manifestType);
    if (!prefix) continue;
    const basePath = `${prefix}${parsed.packageId}/`;
    for (const [p, bytes] of pkg.files) {
      if (p === "RECORD") continue;
      files[`${basePath}${p}`] = bytes;
      decompressedSize += bytes.byteLength;
    }
  }

  const promptBytes = rootPkg.files.get("prompt.md");
  const prompt = promptBytes ? new TextDecoder().decode(promptBytes) : "";

  return {
    manifest: rootPkg.manifest as Record<string, unknown>,
    prompt,
    files,
    // The projection has no underlying ZIP — callers that need these for
    // telemetry (quota gating, logging) should use `Bundle.integrity` or
    // re-serialize via `writeBundleToBuffer`.
    compressedSize: 0,
    decompressedSize,
  };
}

function prefixForType(type: unknown): string | null {
  if (type === "tool") return "tools/";
  if (type === "skill") return "skills/";
  if (type === "provider") return "providers/";
  return null;
}
