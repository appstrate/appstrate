// SPDX-License-Identifier: Apache-2.0

import { eq, or, isNull, ne } from "drizzle-orm";
import { packages } from "@appstrate/db/schema";
import { asRecord } from "./safe-json.ts";

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

/** Extract displayName from a package's draftManifest JSONB, falling back to the package ID. */
export function getPackageDisplayName(pkg: { id: string; draftManifest: unknown }): string {
  const m = asRecord(pkg.draftManifest);
  return typeof m.displayName === "string" ? m.displayName : pkg.id;
}
