// SPDX-License-Identifier: Apache-2.0

import { eq, or, isNull, ne, sql } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import { asRecord } from "@appstrate/core/safe-json";

/** Drizzle filter: packages owned by org OR system packages (orgId: null). */
export function orgOrSystemFilter(orgId: string) {
  return or(eq(packages.orgId, orgId), isNull(packages.orgId))!;
}

/**
 * Drizzle filter: exclude ephemeral shadow packages (inline-run scaffolding).
 * Apply to every user-facing list/detail/search endpoint — the shadow rows
 * MUST NOT surface in the packages catalog, agent list, or search results.
 * Internal code that deliberately operates on shadow rows (inline run
 * pipeline, compaction worker) bypasses this filter.
 */
export function notEphemeralFilter() {
  return ne(packages.ephemeral, true);
}

/**
 * AFPS §10.1 vendor namespace carrying the visibility extension:
 * `_meta["dev.appstrate/visibility"] = { "level": "unlisted" }`.
 */
export const VISIBILITY_META_NAMESPACE = "dev.appstrate/visibility";

/**
 * Drizzle filter: exclude packages that opted out of the catalogue surfaces.
 *
 * Visibility is DISCOVERABILITY, never authorization (NuGet / Chrome Web Store
 * `unlisted`): an unlisted package stays fully resolvable by exact id — the
 * detail route, a `dependencies.skills` reference, version resolution and the
 * run gate are untouched, and any caller authorized there may load it. So this
 * belongs on listings only, and nothing may lean on it for access control.
 *
 * In SQL rather than a post-pass in JS so the hint cap and the `total` window
 * count stay honest: filtering after the LIMIT returns a short page and a
 * count that includes rows the caller may not see.
 */
export function listedFilter() {
  return sql`${packages.draftManifest} -> '_meta' -> ${VISIBILITY_META_NAMESPACE} ->> 'level' IS DISTINCT FROM 'unlisted'`;
}

/** Extract display_name from a package's draftManifest JSONB, falling back to the package ID. */
export function getPackageDisplayName(pkg: { id: string; draftManifest: unknown }): string {
  const m = asRecord(pkg.draftManifest);
  return typeof m.display_name === "string" ? m.display_name : pkg.id;
}
