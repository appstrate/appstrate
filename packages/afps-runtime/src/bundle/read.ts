// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Read a `.afps-bundle` archive into an in-memory {@link Bundle}.
 *
 * Enforces spec §10 conformance rules:
 *  - ZIP sanitization (path traversal, absolute paths, backslashes)
 *  - Resource limits (size, file count, depth)
 *  - RECORD verification per package (file-level hashes)
 *  - Per-package integrity (RECORD digest)
 *  - Bundle-level integrity (canonical packages map digest)
 *  - `bundleFormatVersion` MAJOR check
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { BundleError } from "./errors.ts";
import { sanitizeEntries, sumSizes } from "./archive-utils.ts";
import { resolveBundleLimits, type BundleLimits } from "./limits.ts";
import {
  bundleIntegrity,
  computeRecordEntries,
  integrityEqual,
  parseRecord,
  recordIntegrity,
  serializeRecord,
} from "./integrity.ts";
import {
  BUNDLE_FORMAT_VERSION,
  parsePackageIdentity,
  type AfpsManifest,
  type Bundle,
  type BundleFormatVersion,
  type BundleMetadata,
  type BundlePackage,
  type PackageIdentity,
} from "./types.ts";

export interface ReadBundleOptions {
  /** Override the default limits (raise-only). */
  limits?: Partial<BundleLimits>;
  /** Accepted `bundleFormatVersion` MAJORs. Default: `[1]`. */
  supportedMajors?: readonly number[];
}

/** Shape of `bundle.json`. */
interface BundleJson {
  bundleFormatVersion: string;
  root: string;
  packages: Record<string, { path: string; integrity: string }>;
  integrity: string;
  metadata?: BundleMetadata;
}

export async function readBundleFromFile(path: string, opts?: ReadBundleOptions): Promise<Bundle> {
  const buf = await readFile(path);
  return readBundleFromBuffer(new Uint8Array(buf), opts);
}

export function readBundleFromBuffer(buffer: Uint8Array, opts: ReadBundleOptions = {}): Bundle {
  const limits = resolveBundleLimits(opts.limits);
  const supportedMajors = opts.supportedMajors ?? [1];

  if (buffer.length > limits.maxCompressedBytes) {
    throw new BundleError(
      "LIMITS_EXCEEDED",
      `bundle archive (${buffer.length} bytes) exceeds compressed limit ${limits.maxCompressedBytes}`,
      { field: "compressedBytes", bytes: buffer.length },
    );
  }

  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(buffer);
  } catch (err) {
    throw new BundleError(
      "ARCHIVE_INVALID",
      `failed to decompress bundle: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const fileCount = Object.keys(raw).filter((k) => !k.endsWith("/")).length;
  if (fileCount > limits.maxFiles) {
    throw new BundleError(
      "LIMITS_EXCEEDED",
      `bundle has ${fileCount} files — exceeds limit ${limits.maxFiles}`,
      { field: "files", count: fileCount },
    );
  }

  const sanitized = sanitizeEntries(raw, { limits, context: "bundle" });
  const decompressed = sumSizes(sanitized);
  if (decompressed > limits.maxDecompressedBytes) {
    throw new BundleError(
      "LIMITS_EXCEEDED",
      `decompressed bundle (${decompressed} bytes) exceeds limit ${limits.maxDecompressedBytes}`,
      { field: "decompressedBytes", bytes: decompressed },
    );
  }

  const bundleJsonBytes = sanitized.get("bundle.json");
  if (!bundleJsonBytes) {
    throw new BundleError("BUNDLE_JSON_MISSING", "archive does not contain bundle.json");
  }

  const bundleJson = parseBundleJson(bundleJsonBytes);

  const versionParts = bundleJson.bundleFormatVersion.split(".");
  const majorStr = versionParts[0];
  const major = majorStr ? Number(majorStr) : NaN;
  if (!Number.isInteger(major) || !supportedMajors.includes(major)) {
    throw new BundleError(
      "VERSION_UNSUPPORTED",
      `bundleFormatVersion ${bundleJson.bundleFormatVersion} not supported (accepts majors: ${supportedMajors.join(", ")})`,
      { got: bundleJson.bundleFormatVersion, supportedMajors },
    );
  }

  const packageCount = Object.keys(bundleJson.packages).length;
  if (packageCount > limits.maxPackages) {
    throw new BundleError(
      "LIMITS_EXCEEDED",
      `bundle has ${packageCount} packages — exceeds limit ${limits.maxPackages}`,
      { field: "packages", count: packageCount },
    );
  }

  // Validate each identity, verify RECORD per package, collect
  // BundlePackage, verify per-package integrity.
  const packages = new Map<PackageIdentity, BundlePackage>();
  for (const [identityStr, entry] of Object.entries(bundleJson.packages)) {
    if (identityStr.length > limits.maxIdentityBytes) {
      throw new BundleError(
        "LIMITS_EXCEEDED",
        `package identity exceeds ${limits.maxIdentityBytes} bytes: ${identityStr}`,
        { field: "identityBytes", identity: identityStr },
      );
    }
    const parsed = parsePackageIdentity(identityStr);
    if (!parsed) {
      throw new BundleError(
        "BUNDLE_JSON_INVALID",
        `invalid package identity: ${JSON.stringify(identityStr)}`,
      );
    }
    const identity = identityStr as PackageIdentity;
    const pkgPath = entry.path;
    if (!pkgPath || !pkgPath.endsWith("/") || pkgPath.startsWith("/")) {
      throw new BundleError(
        "BUNDLE_JSON_INVALID",
        `invalid package path for ${identity}: ${JSON.stringify(pkgPath)}`,
      );
    }

    const pkgFiles = new Map<string, Uint8Array>();
    for (const [key, value] of sanitized) {
      if (key.startsWith(pkgPath)) {
        const rel = key.slice(pkgPath.length);
        if (rel.length > 0) pkgFiles.set(rel, value);
      }
    }

    const recordBytes = pkgFiles.get("RECORD");
    if (!recordBytes) {
      throw new BundleError("RECORD_MISSING", `package ${identity} missing RECORD file`, {
        identity,
        path: pkgPath,
      });
    }
    const recordBody = new TextDecoder().decode(recordBytes);
    const recordEntries = parseRecord(recordBody);
    const recordIndex = new Map(recordEntries.map((e) => [e.path, e]));

    // Every file in the directory (except RECORD) must appear in RECORD,
    // with matching hash and size.
    for (const [relPath, data] of pkgFiles) {
      if (relPath === "RECORD") continue;
      const entry = recordIndex.get(relPath);
      if (!entry) {
        throw new BundleError(
          "RECORD_MISMATCH",
          `file ${relPath} in ${identity} is not listed in RECORD`,
          { identity, path: relPath },
        );
      }
      if (entry.size !== data.length) {
        throw new BundleError(
          "RECORD_MISMATCH",
          `file ${relPath} in ${identity}: size mismatch (expected ${entry.size}, got ${data.length})`,
          { identity, path: relPath },
        );
      }
      const computed = `sha256=${sha256Digest(data).toString("base64").replace(/=+$/, "")}`;
      if (computed !== entry.hash) {
        throw new BundleError("RECORD_MISMATCH", `file ${relPath} in ${identity}: hash mismatch`, {
          identity,
          path: relPath,
          expected: entry.hash,
          computed,
        });
      }
    }
    // RECORD must not reference missing files.
    for (const entry of recordEntries) {
      if (!pkgFiles.has(entry.path)) {
        throw new BundleError(
          "RECORD_MISMATCH",
          `RECORD entry ${entry.path} in ${identity} has no corresponding file`,
          { identity, path: entry.path },
        );
      }
    }

    // Recompute RECORD from the on-disk files and verify the body bytes
    // match what we read — this catches subtle RECORD reorderings that
    // individual file checks miss.
    const recomputed = serializeRecord(computeRecordEntries(pkgFiles));
    if (recomputed !== recordBody) {
      throw new BundleError("RECORD_MALFORMED", `RECORD in ${identity} is not in canonical form`, {
        identity,
      });
    }

    const computedPkgIntegrity = recordIntegrity(recordBody);
    if (!integrityEqual(computedPkgIntegrity, entry.integrity)) {
      throw new BundleError(
        "INTEGRITY_MISMATCH",
        `package ${identity}: per-package integrity mismatch`,
        {
          identity,
          expected: entry.integrity,
          computed: computedPkgIntegrity,
        },
      );
    }

    const manifestBytes = pkgFiles.get("manifest.json");
    if (!manifestBytes) {
      throw new BundleError("BUNDLE_JSON_INVALID", `package ${identity} missing manifest.json`, {
        identity,
      });
    }
    let manifest: AfpsManifest;
    try {
      const parsedManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
      if (!parsedManifest || typeof parsedManifest !== "object" || Array.isArray(parsedManifest)) {
        throw new Error("manifest.json must be a JSON object");
      }
      manifest = parsedManifest as AfpsManifest;
    } catch (err) {
      throw new BundleError(
        "BUNDLE_JSON_INVALID",
        `manifest.json for ${identity} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { identity },
      );
    }

    packages.set(identity, {
      identity,
      manifest,
      files: pkgFiles,
      integrity: computedPkgIntegrity,
    });
  }

  // Verify bundle-level integrity over the canonical packages map (sans
  // metadata). Rebuild from the declared entries (path + integrity) so
  // any drift between declared & computed per-package integrity already
  // surfaced above.
  const bundleLevel = new Map<PackageIdentity, { path: string; integrity: string }>();
  for (const [id, entry] of Object.entries(bundleJson.packages)) {
    bundleLevel.set(id as PackageIdentity, { path: entry.path, integrity: entry.integrity });
  }
  const computedIntegrity = bundleIntegrity(bundleLevel);
  if (!integrityEqual(computedIntegrity, bundleJson.integrity)) {
    throw new BundleError("INTEGRITY_MISMATCH", `bundle.json integrity mismatch`, {
      expected: bundleJson.integrity,
      computed: computedIntegrity,
    });
  }

  const rootIdentity = bundleJson.root as PackageIdentity;
  if (!packages.has(rootIdentity)) {
    throw new BundleError(
      "BUNDLE_JSON_INVALID",
      `root ${rootIdentity} is not present in packages map`,
      { root: rootIdentity },
    );
  }

  return {
    bundleFormatVersion: bundleJson.bundleFormatVersion as BundleFormatVersion,
    root: rootIdentity,
    packages,
    integrity: computedIntegrity,
    metadata: bundleJson.metadata,
  };
}

function parseBundleJson(bytes: Uint8Array): BundleJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new BundleError(
      "BUNDLE_JSON_INVALID",
      `bundle.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BundleError("BUNDLE_JSON_INVALID", "bundle.json must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.bundleFormatVersion !== "string") {
    throw new BundleError("BUNDLE_JSON_INVALID", "bundle.json missing bundleFormatVersion");
  }
  if (typeof obj.root !== "string") {
    throw new BundleError("BUNDLE_JSON_INVALID", "bundle.json missing root");
  }
  if (typeof obj.integrity !== "string") {
    throw new BundleError("BUNDLE_JSON_INVALID", "bundle.json missing integrity");
  }
  if (!obj.packages || typeof obj.packages !== "object" || Array.isArray(obj.packages)) {
    throw new BundleError("BUNDLE_JSON_INVALID", "bundle.json packages must be an object");
  }
  const pkgEntries = obj.packages as Record<string, unknown>;
  const packages: Record<string, { path: string; integrity: string }> = {};
  for (const [id, rawEntry] of Object.entries(pkgEntries)) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new BundleError("BUNDLE_JSON_INVALID", `bundle.json.packages[${id}] must be an object`);
    }
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.path !== "string" || typeof entry.integrity !== "string") {
      throw new BundleError(
        "BUNDLE_JSON_INVALID",
        `bundle.json.packages[${id}] missing path/integrity`,
      );
    }
    packages[id] = { path: entry.path, integrity: entry.integrity };
  }
  let metadata: BundleMetadata | undefined;
  if (obj.metadata !== undefined) {
    if (!obj.metadata || typeof obj.metadata !== "object" || Array.isArray(obj.metadata)) {
      throw new BundleError("BUNDLE_JSON_INVALID", "bundle.json metadata must be an object");
    }
    metadata = obj.metadata as BundleMetadata;
  }
  return {
    bundleFormatVersion: obj.bundleFormatVersion,
    root: obj.root,
    packages,
    integrity: obj.integrity,
    metadata,
  };
}

function sha256Digest(data: Uint8Array): Buffer {
  const h = createHash("sha256");
  h.update(data);
  return h.digest();
}

export { BUNDLE_FORMAT_VERSION };
