// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-side bundle import — takes a parsed multi-package {@link Bundle}
 * and registers every embedded package (one packages row + one
 * packageVersions row + stored ZIP) in the current org, then installs
 * the root in the current application.
 *
 * Conflict semantics (spec §9.2):
 *   - Per-version identity is `(packageId, version, zipIntegrity)`.
 *   - If `(packageId, version)` already exists with matching integrity
 *     → reuse (no-op).
 *   - If `(packageId, version)` already exists with a different
 *     integrity → fail-fast with a 409 listing the diverging identities.
 *   - System packages (`isSystemPackage`) are always reused, never
 *     overwritten.
 *   - Cross-org collisions (a package with the same id owned by another
 *     org) fail-fast with a 409.
 *
 * This helper is transaction-aware insofar as each package is inserted
 * by `postInstallPackage` which uses `createVersionAndUpload` —
 * duplicates are caught before any storage write and surfaced to the
 * caller. Partial failures (e.g. half the packages succeed, then one
 * conflicts) are left in place: new inserts are harmless, and the
 * failed package is reported. For strict atomicity, a full-import
 * transaction will be added once storage becomes CAS (§Phase 4).
 */

import { zipSync, type AsyncZippableFile } from "fflate";
import type { Bundle, BundlePackage } from "@appstrate/afps-runtime/bundle";
import {
  extractRootFromAfps,
  parsePackageIdentity,
  readBundleFromBuffer,
} from "@appstrate/afps-runtime/bundle";
import { parsePackageZip } from "@appstrate/core/zip";
import { db } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import { and, eq } from "drizzle-orm";
import { conflict, invalidRequest } from "../lib/errors.ts";
import { isSystemPackage } from "./system-packages.ts";
import { postInstallPackage } from "./post-install-package.ts";
import { buildBundleFromUploadedAfps, type BundleAssemblyScope } from "./bundle-assembly.ts";
import { installPackage } from "./application-packages.ts";
import { downloadVersionZip } from "./package-storage.ts";
import { logger } from "../lib/logger.ts";

// Pinned mtime — must match the bundle writer exactly for cross-format
// integrity parity. Anchored at 1980-01-02T12:00Z so fflate's local-TZ
// year check stays in 1980 across UTC-12..UTC+14; see
// `packages/afps-runtime/src/bundle/write.ts`.
const DOS_EPOCH_MS = Date.UTC(1980, 0, 2, 12, 0, 0);

/**
 * Reconstruct a deterministic per-package AFPS ZIP from a
 * {@link BundlePackage}. Two calls with the same files map produce
 * byte-identical output (sorted paths + STORE compression + pinned mtime).
 */
export function reconstructPackageZip(pkg: BundlePackage): Uint8Array {
  const sortedPaths = [...pkg.files.keys()].filter((p) => p !== "RECORD").sort();
  const input: Record<string, AsyncZippableFile> = {};
  for (const p of sortedPaths) {
    input[p] = [pkg.files.get(p)!, { mtime: DOS_EPOCH_MS, level: 0 }];
  }
  return zipSync(
    input as unknown as Parameters<typeof zipSync>[0],
    { level: 0, mtime: DOS_EPOCH_MS } as Parameters<typeof zipSync>[1],
  );
}

// ---------------------------------------------------------------------------
// Content detection — peek the first few bytes to distinguish .afps-bundle
// from a raw .afps (single-package authoring format).
// ---------------------------------------------------------------------------

/**
 * Heuristic: a `.afps-bundle` archive contains a `bundle.json` entry at
 * its root; a raw `.afps` archive contains `manifest.json`. The central
 * directory scan is cheap — we don't decompress until we know which
 * reader to call.
 */
function looksLikeAfpsBundle(bytes: Uint8Array): boolean {
  // Super-cheap scan: find the literal string "bundle.json" in the
  // first few KiB of the archive. ZIP central directories live at the
  // END of the file, but filenames are also emitted in local file
  // headers near the START — so this works on typical small archives.
  // False-positives are impossible (a `.afps` has no such filename) and
  // a false-negative falls through to the bundle reader which will
  // raise `BUNDLE_JSON_MISSING` — an acceptable error shape.
  const needle = new TextEncoder().encode("bundle.json");
  const hay = bytes.subarray(0, Math.min(bytes.byteLength, 65536));
  for (let i = 0; i + needle.length <= hay.byteLength; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Parse bytes as either an `.afps-bundle` (multi-package) or a raw
 * `.afps` (single-package authoring format — promoted to a bundle-of-one
 * via the same catalog composition as classic runs).
 */
export async function readOrBuildBundle(
  bytes: Uint8Array,
  scope: BundleAssemblyScope,
): Promise<Bundle> {
  if (looksLikeAfpsBundle(bytes)) return readBundleFromBuffer(bytes);
  return buildBundleFromUploadedAfps(bytes, scope);
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

export interface BundleConflict {
  identity: string;
  reason: "integrity_mismatch" | "foreign_org_owner";
  existingIntegrity?: string;
  incomingIntegrity?: string;
  existingOrgId?: string | null;
}

/**
 * Pre-flight check: does every (packageId, version) in the bundle match
 * what the DB currently knows? Runs ONLY reads — no writes. The caller
 * decides whether a non-empty result is a 409.
 */
export async function detectBundleConflicts(
  bundle: Bundle,
  scope: BundleAssemblyScope,
): Promise<BundleConflict[]> {
  const conflicts: BundleConflict[] = [];

  for (const [identity, pkg] of bundle.packages) {
    const parsed = parsePackageIdentity(identity);
    if (!parsed) continue;
    const packageId = parsed.packageId;
    const version = parsed.version;

    // System packages always reuse — they ship with the platform and
    // are authoritative even across instances.
    if (isSystemPackage(packageId)) continue;

    // Cross-org ownership: a row with the same id owned by another org
    // is a hard conflict. Cross-instance imports never trip this (the
    // dest has no prior row). Same-instance cross-org collisions are
    // rare in production but possible if two orgs publish the same
    // scoped name — surface a clear 409 rather than silently failing
    // to install.
    const [existingPkg] = await db
      .select({ orgId: packages.orgId })
      .from(packages)
      .where(eq(packages.id, packageId))
      .limit(1);
    if (existingPkg && existingPkg.orgId && existingPkg.orgId !== scope.orgId) {
      conflicts.push({
        identity,
        reason: "foreign_org_owner",
        existingOrgId: existingPkg.orgId,
      });
      continue;
    }

    // Per-version content check. The bundle carries a RECORD-based
    // content integrity (`pkg.integrity`); the DB stores the AFPS ZIP
    // envelope integrity. They have different inputs, so we can't
    // compare them directly — decode the stored ZIP back into a
    // BundlePackage (which recomputes the RECORD hash the same way),
    // then compare content hashes. Two round-trips of the same content
    // yield the same RECORD integrity regardless of ZIP envelope.
    const [existingVer] = await db
      .select({ integrity: packageVersions.integrity, version: packageVersions.version })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
      .limit(1);
    if (existingVer) {
      const storedZip = await downloadVersionZip(packageId, existingVer.version);
      if (storedZip) {
        const storedPkg = extractRootFromAfps(new Uint8Array(storedZip));
        if (storedPkg.integrity !== pkg.integrity) {
          conflicts.push({
            identity,
            reason: "integrity_mismatch",
            existingIntegrity: storedPkg.integrity,
            incomingIntegrity: pkg.integrity,
          });
        }
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportedPackageResult {
  identity: string;
  status: "inserted" | "reused";
  versionId: number | null;
}

export interface ImportBundleResult {
  imported: ImportedPackageResult[];
  rootInstalled: boolean;
  rootPackageId: string;
  rootVersion: string;
}

/**
 * Import every package in {@link bundle} into the org registry, then
 * install the root in the calling application. Conflict-free by
 * construction — the caller MUST have run {@link detectBundleConflicts}
 * first and rejected any non-empty result.
 */
export async function importBundle(
  bundle: Bundle,
  scope: BundleAssemblyScope,
  userId: string,
): Promise<ImportBundleResult> {
  const imported: ImportedPackageResult[] = [];

  for (const [identity, pkg] of bundle.packages) {
    const parsedIdentity = parsePackageIdentity(identity);
    if (!parsedIdentity) {
      throw invalidRequest(`Invalid package identity in bundle: ${identity}`);
    }
    const packageId = parsedIdentity.packageId;
    const version = parsedIdentity.version;

    if (isSystemPackage(packageId)) {
      imported.push({ identity, status: "reused", versionId: null });
      continue;
    }

    // Reuse path — version already present. The caller MUST have called
    // `detectBundleConflicts` first, so if a row exists here the content
    // is guaranteed equivalent (RECORD integrity match). Skip the upload
    // to avoid clobbering the storage ZIP with our reconstructed bytes
    // (which use STORE + pinned mtime and therefore a different envelope
    // SHA than the original publish).
    const [existingVer] = await db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
      .limit(1);
    if (existingVer) {
      imported.push({ identity, status: "reused", versionId: existingVer.id });
      continue;
    }

    const reconstructed = reconstructPackageZip(pkg);

    // Parse the reconstructed ZIP through the shared platform primitive
    // so we get the same manifest/content/files/type shape used by
    // /packages/import — keeps the skill content extraction, file tree
    // separation, and per-type validation in one place.
    let parsedZip: ReturnType<typeof parsePackageZip>;
    try {
      parsedZip = parsePackageZip(reconstructed);
    } catch (err) {
      throw invalidRequest(
        `Invalid package '${identity}' in bundle: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Ensure a packages row exists before the version snapshot. If a
    // row with the same id already exists owned by another org, leave
    // it alone — the imported version becomes a parallel snapshot
    // attached to that pre-existing package (safe because integrity
    // matched OR the row is new). Don't clobber another org's draft.
    await db
      .insert(packages)
      .values({
        id: packageId,
        orgId: scope.orgId,
        type: parsedZip.type,
        source: "local",
        draftManifest: parsedZip.manifest,
        draftContent: parsedZip.content,
        createdBy: userId,
      })
      .onConflictDoNothing({ target: packages.id });

    await postInstallPackage({
      packageType: parsedZip.type,
      packageId,
      orgId: scope.orgId,
      userId,
      content: parsedZip.content,
      files: parsedZip.files,
      zipBuffer: Buffer.from(reconstructed),
      version,
    });

    const [newVer] = await db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
      .limit(1);
    imported.push({
      identity,
      status: "inserted",
      versionId: newVer?.id ?? null,
    });
  }

  // Install root in the application (idempotent — no-op if already there).
  const rootParsed = parsePackageIdentity(bundle.root);
  if (!rootParsed) {
    throw invalidRequest("Bundle root identity is invalid");
  }
  let rootInstalled = false;
  try {
    await installPackage(scope, rootParsed.packageId);
    rootInstalled = true;
  } catch (err) {
    // Conflict or already-installed is fine — surface the root id + swallow.
    logger.debug("Root install skipped", {
      packageId: rootParsed.packageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    imported,
    rootInstalled,
    rootPackageId: rootParsed.packageId,
    rootVersion: rootParsed.version,
  };
}

/**
 * End-to-end import entry point used by the `POST /api/packages/import-bundle`
 * route. Composes read → detect conflicts → import.
 */
export async function handleImportBundle(
  bytes: Uint8Array,
  scope: BundleAssemblyScope,
  userId: string,
): Promise<ImportBundleResult> {
  const bundle = await readOrBuildBundle(bytes, scope);
  const conflicts = await detectBundleConflicts(bundle, scope);
  if (conflicts.length > 0) {
    const summary = conflicts
      .map((c) =>
        c.reason === "foreign_org_owner"
          ? `${c.identity} is owned by another org`
          : `${c.identity} has divergent integrity (expected ${c.existingIntegrity}, got ${c.incomingIntegrity})`,
      )
      .join("; ");
    throw conflict("bundle_conflict", `Bundle conflicts with existing packages: ${summary}`);
  }
  return importBundle(bundle, scope, userId);
}

// Re-export the root extractor so the route doesn't have to reach into
// `@appstrate/afps-runtime/bundle` directly for the bundle-of-one path.
export { extractRootFromAfps };
