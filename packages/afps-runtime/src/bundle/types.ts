// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Core types for the {@link Bundle} contract.
 *
 * A Bundle is an executable distribution artifact: a root AFPS package
 * plus all its transitively-resolved dependencies, pinned to exact
 * versions, with integrity hashes, ready for a runner to execute.
 *
 * See `docs/architecture/BUNDLE_FORMAT_SPEC.md` for the full spec.
 */

/** Bundle format MAJOR.MINOR. Consumers reject higher MAJOR. */
export const BUNDLE_FORMAT_VERSION = "1.0" as const;
export type BundleFormatVersion = typeof BUNDLE_FORMAT_VERSION;

/**
 * Template-literal type for package identities. AFPS 1.x mandates
 * scoped names, so every identity is `@scope/name@version`.
 */
export type PackageIdentity = `@${string}/${string}@${string}`;

/**
 * Parsed identity. Returned by {@link parsePackageIdentity}.
 */
export interface ParsedPackageIdentity {
  readonly scope: string;
  readonly name: string;
  readonly version: string;
  readonly packageId: `@${string}/${string}`;
}

/** Minimal shape validators receive — matches `@afps-spec/schema` output. */
export type AfpsManifest = Record<string, unknown>;

/** Optional informational metadata. Not covered by bundle integrity. */
export interface BundleMetadata {
  createdAt?: string;
  builder?: string;
  sourceRunId?: string;
  /** Vendor extensions — must use `x-` prefix per spec §4.3. */
  [key: `x-${string}`]: unknown;
  /** Reserved-namespace keys preserved on round-trip. */
  [key: string]: unknown;
}

/** A single package inside a bundle. */
export interface BundlePackage {
  readonly identity: PackageIdentity;
  /** Parsed `manifest.json`, unchanged from authoring. */
  readonly manifest: AfpsManifest;
  /**
   * Companion files by posix-normalized path, relative to the package
   * directory. Includes `manifest.json` itself so downstream tooling has
   * the raw bytes (needed for deterministic RECORD).
   */
  readonly files: Map<string, Uint8Array>;
  /**
   * SRI hash (`sha256-<b64-padded>`) over the canonical RECORD bytes.
   * Authoritative per-package integrity.
   */
  readonly integrity: string;
}

/** The in-memory Bundle type the runtime consumes. */
export interface Bundle {
  readonly bundleFormatVersion: BundleFormatVersion;
  readonly root: PackageIdentity;
  /** Flat, deduped-by-identity map. */
  readonly packages: Map<PackageIdentity, BundlePackage>;
  /** SRI hash (`sha256-<b64-padded>`) over the canonical packages map. */
  readonly integrity: string;
  readonly metadata?: BundleMetadata;
}

/** Resolved identity + integrity — the lightweight result of `catalog.resolve`. */
export interface ResolvedPackage {
  readonly identity: PackageIdentity;
  /**
   * Expected integrity at resolution time. May be used by catalogs to
   * short-circuit `fetch` when the content is already cached under the
   * same digest. `null` when the catalog cannot predict it without
   * fetching (e.g. a live registry lookup).
   */
  readonly integrity?: string | null;
}

/**
 * Abstract catalog contract used by builders to resolve+fetch packages.
 *
 * Concrete implementations live next to the source of truth they wrap
 * (DB, workspace, cache, in-memory payload).
 */
export interface PackageCatalog {
  /**
   * Resolve a name + version specifier to a concrete identity. Returns
   * `null` if the name is not present in this catalog, or no version in
   * the catalog satisfies `versionSpec`.
   *
   * `versionSpec` accepts exact versions (`"1.2.3"`, `"=1.2.3"`), semver
   * ranges (`"^1.2"`, `">=1.0 <2.0"`, `"*"`), and dist-tags (`"latest"`).
   */
  resolve(name: string, versionSpec: string): Promise<ResolvedPackage | null>;

  /**
   * Fetch the full package content for an already-resolved identity.
   * MUST throw if the identity is not present — callers only invoke
   * this with identities produced by `resolve` of the same catalog.
   */
  fetch(identity: PackageIdentity): Promise<BundlePackage>;
}

/**
 * Parse `@scope/name@version` identity string. Returns `null` for any
 * string that does not match the AFPS scoped-identity grammar.
 */
export function parsePackageIdentity(s: string): ParsedPackageIdentity | null {
  if (typeof s !== "string" || s.length === 0 || s.length > 4096) return null;
  if (!s.startsWith("@")) return null;
  const atIdx = s.lastIndexOf("@");
  if (atIdx <= 0) return null;
  const pkgId = s.slice(0, atIdx);
  const version = s.slice(atIdx + 1);
  if (!version) return null;
  const slash = pkgId.indexOf("/");
  if (slash <= 1) return null;
  const scope = pkgId.slice(1, slash);
  const name = pkgId.slice(slash + 1);
  if (!scope || !name) return null;
  return {
    scope,
    name,
    version,
    packageId: pkgId as `@${string}/${string}`,
  };
}

/**
 * Format a `@scope/name@version` identity from parts.
 */
export function formatPackageIdentity(
  packageId: `@${string}/${string}`,
  version: string,
): PackageIdentity {
  return `${packageId}@${version}` as PackageIdentity;
}
