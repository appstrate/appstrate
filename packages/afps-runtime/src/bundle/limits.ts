// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Resource limits enforced by the bundle runtime.
 *
 * Defaults match spec §10.8. All limits are raise-only via env vars
 * (`APPSTRATE_BUNDLE_MAX_*`) — implementations MUST NOT silently lower
 * them.
 */

export interface BundleLimits {
  /** Compressed archive size cap (bytes). */
  maxCompressedBytes: number;
  /** Decompressed total cap (bytes). */
  maxDecompressedBytes: number;
  /** Per-file decompressed cap (bytes). */
  maxFileBytes: number;
  /** Max entry count across all packages. */
  maxFiles: number;
  /** Max path segments (depth) per entry. */
  maxPathDepth: number;
  /** Max bytes of a single `PackageIdentity` string. */
  maxIdentityBytes: number;
  /** Max number of packages in `bundle.json.packages`. */
  maxPackages: number;
}

const KiB = 1024;
const MiB = 1024 * KiB;

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
  maxCompressedBytes: 50 * MiB,
  maxDecompressedBytes: 200 * MiB,
  maxFileBytes: 20 * MiB,
  maxFiles: 10_000,
  maxPathDepth: 16,
  maxIdentityBytes: 4_096,
  maxPackages: 512,
};

function readIntEnv(name: string): number | null {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Resolve limits from (in order of precedence):
 *   1. explicit per-call `overrides` — used as-is
 *   2. env vars — raise-only from the default
 *   3. default
 *
 * Per spec §10.8 env vars MAY raise caps but MUST NOT silently lower
 * them. Explicit overrides are an opt-in caller decision (tests lower
 * caps to trigger LIMITS_EXCEEDED; trusted loaders raise them) and
 * override env + default directly.
 */
export function resolveBundleLimits(overrides?: Partial<BundleLimits>): BundleLimits {
  const envMaxCompressed = readIntEnv("APPSTRATE_BUNDLE_MAX_SIZE");
  const envMaxDecompressed = readIntEnv("APPSTRATE_BUNDLE_MAX_DECOMPRESSED");
  const envMaxFiles = readIntEnv("APPSTRATE_BUNDLE_MAX_FILES");
  const envMaxPackages = readIntEnv("APPSTRATE_BUNDLE_MAX_PACKAGES");

  const base: BundleLimits = {
    maxCompressedBytes: Math.max(DEFAULT_BUNDLE_LIMITS.maxCompressedBytes, envMaxCompressed ?? 0),
    maxDecompressedBytes: Math.max(
      DEFAULT_BUNDLE_LIMITS.maxDecompressedBytes,
      envMaxDecompressed ?? 0,
    ),
    maxFileBytes: DEFAULT_BUNDLE_LIMITS.maxFileBytes,
    maxFiles: Math.max(DEFAULT_BUNDLE_LIMITS.maxFiles, envMaxFiles ?? 0),
    maxPathDepth: DEFAULT_BUNDLE_LIMITS.maxPathDepth,
    maxIdentityBytes: DEFAULT_BUNDLE_LIMITS.maxIdentityBytes,
    maxPackages: Math.max(DEFAULT_BUNDLE_LIMITS.maxPackages, envMaxPackages ?? 0),
  };

  return { ...base, ...(overrides ?? {}) };
}
