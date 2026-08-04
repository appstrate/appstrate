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
 *     org) fail-fast with a 409. This is ENFORCED inside `importBundle`,
 *     atomically with the write (per-package transaction + advisory lock) —
 *     the `detectBundleConflicts` preflight is a UX courtesy that reports
 *     all conflicts at once, not the security boundary.
 *
 * This helper is transaction-aware insofar as each package is inserted
 * by `postInstallPackage` which uses `createVersionAndUpload` —
 * duplicates are caught before any storage write and surfaced to the
 * caller. A genuine version-creation failure on any package ABORTS the
 * whole import (the error propagates) rather than committing a `packages`
 * row with no version (an un-runnable orphan) — earlier-inserted packages
 * remain (new inserts are harmless). For strict all-or-nothing atomicity,
 * a full-import transaction will be added once storage becomes CAS
 * (§Phase 4).
 */

import { zipSync, unzipSync, type AsyncZippableFile } from "fflate";
import type { Bundle, BundlePackage } from "@appstrate/afps-runtime/bundle";
import {
  extractRootFromAfps,
  parsePackageIdentity,
  readBundleFromBuffer,
} from "@appstrate/afps-runtime/bundle";
import { getErrorMessage } from "@appstrate/core/errors";
import { parsePackageZip } from "@appstrate/core/zip";
import { db } from "@appstrate/db/client";
import { packages, packageVersions } from "@appstrate/db/schema";
import { and, eq, notExists, sql } from "drizzle-orm";
import { conflict, invalidRequest, validationFailed } from "../lib/errors.ts";
import type { ValidationFieldError } from "../lib/errors.ts";
import {
  validateAgentIntegrationSelections,
  type CarriedVersion,
} from "./integration-scope-validation.ts";
import { isSystemPackage } from "./system-packages.ts";
import { postInstallPackage } from "./post-install-package.ts";
import { buildBundleFromUploadedAfps, type BundleAssemblyScope } from "./bundle-assembly.ts";
import { installPackage } from "./application-packages.ts";
import { downloadVersionZip } from "./package-storage.ts";
import { logger } from "../lib/logger.ts";
import {
  collectConnectLoginWarnings,
  collectMetaWarnings,
  collectRetiredDependencyKeyWarnings,
} from "./integration-install-warnings.ts";
import { collectAgentInstallWarnings } from "./agent-install-warnings.ts";

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
 * its root; a raw `.afps` archive contains `manifest.json`. We enumerate
 * entry names via the ZIP central directory (`unzipSync` with a `filter`
 * that only matches `bundle.json`) — this reads the directory at the end
 * of the file without decompressing any content. Returns true iff a
 * root-level `bundle.json` entry is present.
 *
 * Total function: `unzipSync` THROWS `invalid zip data` on non-ZIP,
 * truncated, or empty input. We swallow that and return false so such
 * input falls through to the raw `.afps` reader, which raises a typed
 * error instead of a raw throw. The function never throws.
 */
function looksLikeAfpsBundle(bytes: Uint8Array): boolean {
  try {
    const matched = unzipSync(bytes, { filter: (f) => f.name === "bundle.json" });
    return Object.prototype.hasOwnProperty.call(matched, "bundle.json");
  } catch {
    return false;
  }
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
 *
 * UX-only: this preflight lets the caller report EVERY conflict in one
 * response. It is NOT the enforcement point — `importBundle` re-checks
 * ownership atomically with each write, so a package created between this
 * read and the import still aborts with a 409 instead of being grafted.
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
  version_id: number | null;
  /**
   * Package type, present on `inserted` entries only (the reuse paths
   * do not need it). Consumed by the route's audit events.
   */
  type?: string;
}

export interface ImportBundleResult {
  imported: ImportedPackageResult[];
  root_installed: boolean;
  root_package_id: string;
  root_version: string;
  /**
   * Non-blocking install-time warnings (AFPS §7.7) — surfaces
   * `connect.login` selector/criteria patterns the Appstrate runtime engine
   * cannot evaluate (XPath, multi-value JSONPath, xpath criteria). Empty
   * array when no integration manifest in the bundle hits a limitation.
   */
  warnings: string[];
}

export interface BundleImportAuditRecord {
  resourceId: string;
  after: {
    type: string | null;
    version: string | null;
    via: "import:bundle" | "import:document";
    root: boolean;
    document_id?: string;
  };
}

/** Pure audit projection shared by HTTP and MCP document import callers. */
export function bundleImportAuditRecords(
  result: ImportBundleResult,
  source: { via: "import:bundle" } | { via: "import:document"; documentId: string },
): BundleImportAuditRecord[] {
  return result.imported.flatMap((entry) => {
    if (entry.status !== "inserted") return [];
    const identity = parsePackageIdentity(entry.identity);
    return [
      {
        resourceId: identity?.packageId ?? entry.identity,
        after: {
          type: entry.type ?? null,
          version: identity?.version ?? null,
          via: source.via,
          root: entry.identity === `${result.root_package_id}@${result.root_version}`,
          ...(source.via === "import:document" ? { document_id: source.documentId } : {}),
        },
      },
    ];
  });
}

export interface BundleImportPreflight {
  bundle: Bundle;
  conflicts: BundleConflict[];
}

/**
 * Import every package in {@link bundle} into the org registry, then
 * install the root in the calling application. Callers SHOULD run
 * {@link detectBundleConflicts} first for a complete conflict report, but
 * correctness does not depend on it: ownership is re-checked here,
 * atomically with each write, so a concurrent cross-org race resolves to a
 * 409 instead of grafting a version onto another org's package row.
 */
export async function importBundle(
  bundle: Bundle,
  scope: BundleAssemblyScope,
  userId: string,
): Promise<ImportBundleResult> {
  const imported: ImportedPackageResult[] = [];
  const warnings: string[] = [];

  for (const [identity, pkg] of bundle.packages) {
    const parsedIdentity = parsePackageIdentity(identity);
    if (!parsedIdentity) {
      throw invalidRequest(`Invalid package identity in bundle: ${identity}`);
    }
    const packageId = parsedIdentity.packageId;
    const version = parsedIdentity.version;

    if (isSystemPackage(packageId)) {
      imported.push({ identity, status: "reused", version_id: null });
      continue;
    }

    let reconstructed: Uint8Array | undefined;
    let parsedZip: ReturnType<typeof parsePackageZip> | undefined;
    const getReconstructedPackage = (): Uint8Array => {
      reconstructed ??= reconstructPackageZip(pkg);
      return reconstructed;
    };
    const parseIncomingPackage = (): ReturnType<typeof parsePackageZip> => {
      try {
        // READ direction. A bundle is assembled by the platform from its OWN
        // published versions (`GET /api/agents/:scope/:name/bundle`), and a
        // published artifact is immutable by construction. A `runtime_tools`
        // id retired after publication therefore cannot be repaired at the
        // source — rejecting here would abort the ENTIRE bundle (every
        // co-packaged skill and integration with it) on a legacy agent, with no
        // recourse for the operator. Drop the retired ids and surface them as
        // install warnings below.
        return parsePackageZip(getReconstructedPackage(), { retiredRuntimeTools: "drop" });
      } catch (err) {
        throw invalidRequest(`Invalid package '${identity}' in bundle: ${getErrorMessage(err)}`);
      }
    };

    // BundlePackage only guarantees a JSON-object manifest, not Appstrate's
    // per-type contract. Agent warnings can throw on malformed resource data,
    // so agent-shaped packages cross the authoritative parser before either
    // insertion or reuse. Other package types retain the reuse fast path.
    if (pkg.manifest.type === "agent") {
      parsedZip = parseIncomingPackage();
      // Deployment policy can change after a version was first imported.
      // Re-evaluate warnings on every import, including equivalent reuse.
      for (const w of collectAgentInstallWarnings(parsedZip.manifest)) {
        warnings.push(`${identity}: ${w}`);
      }
    }

    // Reuse path — version already present. The preflight
    // (`detectBundleConflicts`) verified content equivalence (RECORD
    // integrity match). Skip the upload to avoid clobbering the storage ZIP
    // with our reconstructed bytes (which use STORE + pinned mtime and
    // therefore a different envelope SHA than the original publish).
    //
    // The owner is re-read HERE (join on `packages`), not trusted from the
    // preflight: a foreign-org package+version created between the preflight
    // and this read must be a 409, not a bogus "reused" success.
    const [existingVer] = await db
      .select({ id: packageVersions.id, ownerOrgId: packages.orgId })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
      .limit(1);
    if (existingVer) {
      if (existingVer.ownerOrgId !== scope.orgId) {
        throw conflict(
          "bundle_conflict",
          `Bundle conflicts with existing packages: ${identity} is owned by another org`,
        );
      }
      imported.push({ identity, status: "reused", version_id: existingVer.id });
      continue;
    }

    // Insertions of every type need the fully parsed content. Agent packages
    // reuse the parse above; other types are parsed only after the reuse check.
    parsedZip ??= parseIncomingPackage();

    // A drop keeps the import alive but is a silent capability loss — lift it
    // into the same non-blocking warning channel the AFPS §7.7 / §10.1
    // soft-fails use, so the operator learns which package needs a republish.
    if (parsedZip.droppedRuntimeTools.length > 0) {
      warnings.push(
        `${identity}: dropped retired runtime tools (${parsedZip.droppedRuntimeTools.join(", ")}) — republish this package to remove them from its manifest`,
      );
    }

    // Surface engine-subset limitations for integration manifests as
    // non-blocking warnings (AFPS §7.7).
    if (parsedZip.type === "integration") {
      for (const w of collectConnectLoginWarnings(parsedZip.manifest)) {
        warnings.push(`${identity}: ${w}`);
      }
    }

    // Surface `_meta` policy warnings for all package types — the validator
    // soft-fails malformed namespace keys to console.warn only (per AFPS §10.1
    // "consumers MUST NOT reject unknown `_meta` keys"). Lift them to the
    // install-warning channel so publishers see them.
    for (const w of collectMetaWarnings(parsedZip.manifest)) {
      warnings.push(`${identity}: ${w}`);
    }

    // Same READ-direction rationale as the runtime-tools drop above: this
    // manifest was validated with `retiredRuntimeTools: "drop"`, so a retired
    // AFPS 1.x `dependencies` key (`tools` / `providers`) is tolerated instead
    // of rejected. It is inert — nothing reads it — so the import succeeds; the
    // warning is how the operator learns the dependencies declared under it
    // were never honoured and that a republish removes the key.
    for (const w of collectRetiredDependencyKeyWarnings(parsedZip.manifest)) {
      warnings.push(`${identity}: ${w}`);
    }

    // Claim-or-validate the packages row ATOMICALLY, in ONE transaction,
    // BEFORE any version row or storage byte is written. This closes the
    // cross-tenant TOCTOU between `detectBundleConflicts` (a read-only
    // preflight kept for UX — it reports ALL conflicts at once) and the
    // write: two concurrent imports of the same id from different orgs both
    // pass the preflight, but only one insert wins; the loser previously
    // fell through and grafted its version + bytes onto the WINNER's row.
    //
    // Serialization per packageId uses the same advisory lock key as
    // `createPackageVersion` (`pg_advisory_xact_lock(hashtext(id))`), so
    // concurrent importers of one id are fully ordered through this claim
    // section; the `FOR UPDATE` re-read additionally guards against a
    // concurrent DELETE (the delete path does not take the advisory lock).
    // The surviving row must be owned by the importing org — anything else
    // (another org, or an orgId-null system-synced row) aborts with a 409.
    //
    // `insertedThisRow` tells us whether THIS call actually inserted the row
    // (vs. reused a same-org survivor) so a post-install failure only rolls
    // back the orphan we created — never a pre-existing row.
    const insertedThisRow = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${packageId}))`);
      const insertedRows = await tx
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
        .onConflictDoNothing({ target: packages.id })
        .returning({ id: packages.id });
      if (insertedRows.length > 0) return true;

      const [survivor] = await tx
        .select({ orgId: packages.orgId })
        .from(packages)
        .where(eq(packages.id, packageId))
        .for("update")
        .limit(1);
      if (!survivor) {
        // Insert conflicted yet the row is gone — a concurrent delete won the
        // race. Surface a retryable conflict rather than guessing.
        throw conflict(
          "bundle_conflict",
          `Bundle conflicts with existing packages: ${identity} was concurrently deleted during import`,
        );
      }
      if (survivor.orgId !== scope.orgId) {
        throw conflict(
          "bundle_conflict",
          `Bundle conflicts with existing packages: ${identity} is owned by another org`,
        );
      }
      return false;
    });

    try {
      await postInstallPackage({
        packageType: parsedZip.type,
        packageId,
        orgId: scope.orgId,
        userId,
        content: parsedZip.content,
        files: parsedZip.files,
        zipBuffer: Buffer.from(getReconstructedPackage()),
        version,
      });
    } catch (err) {
      // Post-install (version snapshot + storage upload) failed. If this
      // import just created the packages row, delete the orphan so we don't
      // leave an un-runnable package with no version. A single self-guarding
      // DELETE (`NOT EXISTS` any package_versions) is atomic — it can't race a
      // concurrent import that commits a version in the window, which a
      // separate SELECT-then-DELETE would cascade-delete. Then rethrow.
      if (insertedThisRow) {
        await db.delete(packages).where(
          and(
            eq(packages.id, packageId),
            eq(packages.orgId, scope.orgId),
            notExists(
              db
                .select({ one: sql`1` })
                .from(packageVersions)
                .where(eq(packageVersions.packageId, packageId)),
            ),
          ),
        );
      }
      throw err;
    }

    const [newVer] = await db
      .select({ id: packageVersions.id })
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, packageId), eq(packageVersions.version, version)))
      .limit(1);
    imported.push({
      identity,
      status: "inserted",
      version_id: newVer?.id ?? null,
      type: parsedZip.type,
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
      err: getErrorMessage(err),
    });
  }

  return {
    imported,
    root_installed: rootInstalled,
    root_package_id: rootParsed.packageId,
    root_version: rootParsed.version,
    warnings,
  };
}

/**
 * Refuse a bundle carrying an agent whose declared integration selects no
 * callable tool — the SAME gate `/import` and the publish route apply
 * (`requireCallableTools`). Without it `/import-bundle` was a verbatim bypass,
 * and `postInstallPackage` froze the broken selection into an immutable
 * version.
 *
 * ALL-OR-NOTHING, and preflight. One invalid agent aborts the WHOLE bundle —
 * "the bundle minus its root" is not a smaller success, it is a half-installed
 * set. Running it here (pure reads, before `detectBundleConflicts` and before
 * the first write) means the refusal costs no rollback.
 *
 * A SELF-CONTAINED bundle is judged too. Its integrations are not in the
 * registry yet, so a DB-only validator hit "integration not installed → skip
 * silently" and waved the agent straight into an immutable version. The catalog
 * handed to the validator is therefore the post-import
 * `incoming ∪ already-installed` catalog: every manifest the bundle carries,
 * keyed by package id, is resolved together with existing versions and
 * dist-tags. Same map covers the mcp-servers a local integration references.
 */
async function assertBundleAgentsExposeCallableTools(bundle: Bundle, orgId: string): Promise<void> {
  // Built once for the whole bundle: an agent may reference an integration that
  // appears anywhere in the package set, not only before it in iteration order.
  //
  // Grouped by package id but keeping EVERY version, because a bundle may carry
  // several versions of one package and the agent's range picks one. Flattening
  // to one manifest per id let an agent pinning `^1` be judged against a carried
  // `2.0.0` — a verdict about a version the run would never resolve.
  const carried = new Map<string, CarriedVersion[]>();
  for (const [identity, pkg] of bundle.packages) {
    const parsed = parsePackageIdentity(identity);
    // System packages are authoritative platform inputs. The importer ignores
    // carried copies below, so letting one participate in validation would
    // judge a manifest the runtime will never install.
    if (!parsed || isSystemPackage(parsed.packageId)) continue;
    const versions = carried.get(parsed.packageId) ?? [];
    versions.push({
      version: parsed.version,
      manifest: pkg.manifest as unknown as Record<string, unknown>,
    });
    carried.set(parsed.packageId, versions);
  }

  const errors: ValidationFieldError[] = [];
  for (const [identity, pkg] of bundle.packages) {
    const parsed = parsePackageIdentity(identity);
    // System packages are reused verbatim, never written — same skip as the
    // import loop.
    if (parsed && isSystemPackage(parsed.packageId)) continue;
    const packageErrors = await validateAgentIntegrationSelections({
      manifest: pkg.manifest as unknown as Record<string, unknown>,
      orgId,
      requireCallableTools: true,
      extraManifests: carried,
    });
    // `field` stays the agent-manifest key; a bundle carries MANY manifests,
    // so the offending identity is prefixed onto the message instead.
    for (const e of packageErrors) {
      errors.push({ ...e, message: `${identity}: ${e.message}` });
    }
  }
  if (errors.length > 0) throw validationFailed(errors);
}

/**
 * Pure-read import preflight shared by HTTP upload and document-backed MCP
 * tools. It performs the exact parse, callable-tool and conflict checks the
 * mutation will use, but writes nothing.
 */
export async function preflightBundleImport(
  bytes: Uint8Array,
  scope: BundleAssemblyScope,
): Promise<BundleImportPreflight> {
  const bundle = await readOrBuildBundle(bytes, scope);
  await assertBundleAgentsExposeCallableTools(bundle, scope.orgId);
  const conflicts = await detectBundleConflicts(bundle, scope);
  return { bundle, conflicts };
}

/**
 * End-to-end import entry point used by the `POST /api/packages/import-bundle`
 * route. Composes read → gate → detect conflicts → import.
 */
export async function handleImportBundle(
  bytes: Uint8Array,
  scope: BundleAssemblyScope,
  userId: string,
): Promise<ImportBundleResult> {
  const { bundle, conflicts } = await preflightBundleImport(bytes, scope);
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
