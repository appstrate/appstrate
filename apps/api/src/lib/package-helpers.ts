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

/** AFPS §10.1 vendor namespace of the visibility extension (`{ "level": "unlisted" }`). */
export const VISIBILITY_META_NAMESPACE = "dev.appstrate/visibility";

/** Drops unlisted packages from catalogue listings, in SQL so LIMIT and totals stay honest. */
export function listedFilter() {
  return sql`${packages.draftManifest} -> '_meta' -> ${VISIBILITY_META_NAMESPACE} ->> 'level' IS DISTINCT FROM 'unlisted'`;
}

/** Extract display_name from a package's draftManifest JSONB, falling back to the package ID. */
export function getPackageDisplayName(pkg: { id: string; draftManifest: unknown }): string {
  const m = asRecord(pkg.draftManifest);
  return typeof m.display_name === "string" ? m.display_name : pkg.id;
}
