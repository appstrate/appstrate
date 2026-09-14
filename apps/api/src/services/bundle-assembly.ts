// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-side bundle assembly helpers.
 *
 * These are thin wrappers over the runtime primitives — the only
 * platform-specific concern is plumbing {@link DbPackageCatalog} through
 * the right composition for each entry point (classic run, import, export
 * endpoint).
 *
 * Runtime primitives are in `@appstrate/afps-runtime/bundle`:
 *   - `buildBundleFromCatalog` — transitive walk
 *   - `buildBundleFromAfps` — raw .afps → Bundle (import path)
 *   - `writeBundleToBuffer` — deterministic `.afps-bundle` serialization
 */

import {
  buildBundleFromAfps,
  buildBundleFromCatalog,
  extractRootFromAfps,
  type Bundle,
  type BundleMetadata,
  type BundlePackage,
} from "@appstrate/afps-runtime/bundle";
import { DbPackageCatalog } from "./run-launcher/db-package-catalog.ts";
import { downloadVersionZip } from "./package-storage.ts";
import { resolveVersion } from "./package-versions.ts";
import { db } from "@appstrate/db/client";
import { packageVersions } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { ApiError, notFound } from "../lib/errors.ts";
import { formatPackageIdentity } from "@appstrate/afps-runtime/bundle";
import type { LoadedPackage } from "../types/index.ts";

export interface BundleAssemblyScope {
  orgId: string;
  spaceId: string;
}

/**
 * Build a Bundle for a classic run — the root agent was resolved from
 * the DB and its transitive deps come from the org registry.
 */
export async function buildBundleFromDb(
  root: BundlePackage,
  scope: BundleAssemblyScope,
  metadata?: BundleMetadata,
): Promise<Bundle> {
  const catalog = new DbPackageCatalog({ orgId: scope.orgId });
  return buildBundleFromCatalog(root, catalog, { metadata, depTypes: ["skills"] });
}

/**
 * Build a Bundle from a raw .afps archive (import path). Applies the
 * same conversion semantics as every other ingestion boundary — one
 * bug-fix surface for manifest parsing, archive sanitization, and
 * integrity computation.
 */
export async function buildBundleFromUploadedAfps(
  archive: Uint8Array,
  scope: BundleAssemblyScope,
  metadata?: BundleMetadata,
): Promise<Bundle> {
  const catalog = new DbPackageCatalog({ orgId: scope.orgId });
  return buildBundleFromAfps(archive, catalog, { metadata });
}

// ---------------------------------------------------------------------------
// Export path — build a Bundle for GET /api/agents/:scope/:name/bundle
// ---------------------------------------------------------------------------

/**
 * Resolve the version of a package that should be exported.
 *
 * Resolution order — TWO steps, the same two a run has (#636):
 *   1. Explicit `versionSpec` (exact / dist-tag / semver range) — 404 if
 *      unresolvable.
 *   2. The `"latest"` dist-tag of the package.
 *
 * There is no per-space step between them. An installation carries no version,
 * so "the version this space runs" and "the latest published version" are the
 * same sentence; an export that answered anything else would hand the CLI
 * different bytes from the ones a server-side run of the same agent executes.
 *
 * Returns the resolved `version` string. Throws `notFound` if no version
 * exists for the package.
 */
export async function resolveExportVersion(
  packageId: string,
  versionSpec?: string | null,
): Promise<string> {
  if (versionSpec) {
    const versionId = await resolveVersion(packageId, versionSpec);
    if (!versionId) {
      throw notFound(`Version '${versionSpec}' not found for '${packageId}'`);
    }
    const [row] = await db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.id, versionId))
      .limit(1);
    if (!row) throw notFound(`Version '${versionSpec}' not found for '${packageId}'`);
    return row.version;
  }

  // Fall back to "latest"
  const latestId = await resolveVersion(packageId, "latest");
  if (latestId) {
    const [row] = await db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.id, latestId))
      .limit(1);
    if (row) return row.version;
  }

  throw notFound(
    `No exportable version found for '${packageId}' — publish a version first, then retry`,
  );
}

/**
 * Build an export Bundle for the given package at the resolved version.
 *
 * Downloads the AFPS ZIP for `(packageId, version)` from storage, runs it
 * through the same extraction primitive as ingestion (`extractRootFromAfps`),
 * and walks transitive dependencies via {@link DbPackageCatalog}. The result
 * is a canonical multi-package Bundle that can be serialised to bytes via
 * {@link writeBundleToBuffer} and streamed to the caller.
 */
export async function buildBundleForAgentExport(
  packageId: string,
  scope: BundleAssemblyScope,
  opts: { versionSpec?: string | null; metadata?: BundleMetadata } = {},
): Promise<Bundle> {
  const version = await resolveExportVersion(packageId, opts.versionSpec);
  const zip = await downloadVersionZip(packageId, version);
  if (!zip) {
    throw notFound(`Artifact missing for '${packageId}@${version}'`);
  }
  const root = extractRootFromAfps(new Uint8Array(zip));
  return buildBundleFromDb(root, scope, opts.metadata);
}

/**
 * Build a Bundle whose ROOT is the agent's DRAFT state (the
 * `packages.draftManifest` + `packages.draftContent` columns) and whose
 * dependencies are the PUBLISHED versions its manifest pins select.
 *
 * The draft is the root and only the root. `?source=draft` is the export of a
 * `version=draft` run, so it must hand the CLI the bytes that run executes —
 * and a server-side `version=draft` run without `dependency_overrides` resolves
 * `dependencies.skills` against published versions
 * (`RunPackageCatalog`, the #666 rule). Walking the closure against draft
 * state instead would ship the working copy of a skill the caller may not even
 * write, which the run route refuses with `403 draft_not_writable` — one
 * selector cannot mean two sets of bytes depending on which door asked. A
 * dependency whose pin resolves to nothing fails here exactly as it fails a
 * run: `422 dependency_unresolved`, naming the skill, never a silent draft
 * fallback. Running a skill's working copy stays possible, by the one act that
 * says so: `dependency_overrides`, which carries its own write-authority gate.
 *
 * Failure mode: if the manifest's `name` / `version` are missing or
 * malformed (e.g. a half-written draft), throws a 400 — drafts must
 * still satisfy the AFPS identity contract before we'll bundle them.
 */
export async function buildBundleFromAgentDraft(
  agent: LoadedPackage,
  scope: BundleAssemblyScope,
  metadata?: BundleMetadata,
): Promise<Bundle> {
  const manifest = agent.manifest as Record<string, unknown>;
  const name = typeof manifest.name === "string" ? manifest.name : null;
  const version = typeof manifest.version === "string" ? manifest.version : null;
  if (!name || !version || !name.startsWith("@") || !name.includes("/")) {
    throw new ApiError({
      status: 400,
      code: "invalid_draft_manifest",
      title: "Invalid Draft Manifest",
      detail: `Draft for '${agent.id}' is missing a valid scoped name + version — fix the manifest before running`,
    });
  }
  const rootFiles = new Map<string, Uint8Array>([
    ["manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2))],
    ["prompt.md", new TextEncoder().encode(agent.prompt)],
  ]);
  const root: BundlePackage = {
    identity: formatPackageIdentity(name as `@${string}/${string}`, version),
    manifest,
    files: rootFiles,
    integrity: "",
  };
  return buildBundleFromDb(root, scope, metadata);
}
