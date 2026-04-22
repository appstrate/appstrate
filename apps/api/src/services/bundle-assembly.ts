// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-side bundle assembly helpers.
 *
 * These are thin wrappers over the runtime primitives — the only
 * platform-specific concern is plumbing {@link DbPackageCatalog} +
 * {@link InMemoryPackageCatalog} through the right composition for each
 * entry point (classic run, inline run, future export endpoint).
 *
 * Runtime primitives are in `@appstrate/afps-runtime/bundle`:
 *   - `buildBundleFromCatalog` — transitive walk
 *   - `buildBundleFromAfps` — raw .afps → Bundle (import path)
 *   - `writeBundleToBuffer` — deterministic `.afps-bundle` serialization
 */

import {
  buildBundleFromAfps,
  buildBundleFromCatalog,
  composeCatalogs,
  InMemoryPackageCatalog,
  type Bundle,
  type BundleMetadata,
  type BundlePackage,
  type PackageCatalog,
} from "@appstrate/afps-runtime/bundle";
import { DbPackageCatalog } from "./adapters/db-package-catalog.ts";

export interface BundleAssemblyScope {
  orgId: string;
  applicationId: string;
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
  return buildBundleFromCatalog(root, catalog, { metadata });
}

/**
 * Build a Bundle for an inline run — the root + any declared companion
 * packages come from the posted payload; unresolved transitive deps
 * fall through to the org registry (spec §9.5).
 */
export async function buildBundleFromInlinePayload(
  root: BundlePackage,
  inlinePackages: BundlePackage[],
  scope: BundleAssemblyScope,
  metadata?: BundleMetadata,
): Promise<Bundle> {
  const inline = new InMemoryPackageCatalog(inlinePackages);
  const db = new DbPackageCatalog({ orgId: scope.orgId });
  const composed: PackageCatalog = composeCatalogs(inline, db);
  return buildBundleFromCatalog(root, composed, { metadata });
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
