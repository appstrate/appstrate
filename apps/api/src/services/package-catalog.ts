// SPDX-License-Identifier: Apache-2.0

import { eq, and, count, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import type { PackageType } from "@appstrate/core/validation";
import { caretRange } from "@appstrate/core/semver";
import type { AgentManifest, LoadedPackage } from "../types/index.ts";
import { asRecord } from "@appstrate/core/safe-json";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { extractSkillIdsFromManifest, parseDraftManifest } from "../lib/manifest-utils.ts";
import { hasPackageAccess } from "./application-packages.ts";

interface DbPackageRow {
  id: string;
  draftManifest: unknown;
  draftContent: string;
  source?: string;
  updatedAt?: Date;
}

/**
 * One entry of a manifest's `dependencies.skills` map, paired with what the
 * org/system catalog knows about it.
 *
 * `resolved` is the whole point. Catalog resolution FILTERS (a declared skill
 * whose package is invisible to the org simply is not there), while display
 * surfaces need to ENRICH (show every declared skill, missing ones included).
 * Collapsing both into a single "here are the skills" array is what let a
 * manifest and a skill list from two different definitions travel together
 * inside one `LoadedPackage` (#878). Callers now state which semantics they
 * want by reading or ignoring this flag.
 */
export interface DeclaredSkill {
  id: string;
  /** Range declared by the manifest, or caret-of-current when it carries none. */
  version: string;
  /** True when a skill package with this id is visible to the org. */
  resolved: boolean;
  name?: string;
  description?: string;
}

function dbRowToLoadedPackage(row: DbPackageRow): LoadedPackage {
  return {
    id: row.id,
    manifest: asRecord(row.draftManifest) as AgentManifest,
    prompt: row.draftContent,
    source: (row.source as "system" | "local") ?? "local",
    updatedAt: row.updatedAt,
  };
}

/**
 * Project a manifest's declared skill dependencies against the org/system
 * catalog.
 *
 * Derived state with a single input: the manifest handed to it. Nothing caches
 * the result on a package object, so it cannot outlive the manifest it was
 * computed from — swap the manifest (draft ↔ published version) and the
 * projection is simply recomputed. Returns one entry per DECLARED skill, in
 * manifest order; `resolved: false` marks a declared skill the org cannot see.
 *
 * No DB read happens when the manifest declares no skills.
 */
export async function resolveDeclaredSkills(
  manifest: AgentManifest,
  orgId: string,
): Promise<DeclaredSkill[]> {
  const m = parseDraftManifest(manifest);
  const declaredRanges = asRecord(asRecord(m.dependencies).skills) as Record<string, string>;
  const skillIds = extractSkillIdsFromManifest(m);
  if (skillIds.length === 0) return [];

  const rows = await db
    .select({
      id: packages.id,
      type: packages.type,
      draftManifest: packages.draftManifest,
    })
    .from(packages)
    .where(and(inArray(packages.id, skillIds), orgOrSystemFilter(orgId)));

  // A row of the wrong type is not a skill dependency, resolved or otherwise.
  const bySkillId = new Map(rows.filter((r) => r.type === "skill").map((r) => [r.id, r]));

  return skillIds.map((id) => {
    const row = bySkillId.get(id);
    if (!row) return { id, version: declaredRanges[id] ?? "*", resolved: false };

    const depManifest = parseDraftManifest(row.draftManifest);
    return {
      id,
      // The manifest's declared range is the source of truth. When a resolved
      // dep carries none (data inconsistency — `extractSkillIdsFromManifest`
      // reads the same section), fall back to caret-of-current rather than
      // emitting a bare wildcard. `version` is "0.0.0" only for a malformed
      // draft, which would not load at runtime anyway.
      version: declaredRanges[id] ?? caretRange(depManifest.version ?? "0.0.0"),
      resolved: true,
      name: depManifest.display_name ?? undefined,
      description: depManifest.description ?? undefined,
    };
  });
}

/**
 * Get a single package by ID. Filters orgId (includes system packages via
 * orgId: null) AND excludes ephemeral shadow packages by default.
 *
 * Set `opts.includeEphemeral` to load an inline-run shadow row directly
 * (used only by the compaction worker and test fixtures — never by
 * user-facing paths).
 */
export async function getPackage(
  id: string,
  orgId: string,
  opts: { includeEphemeral?: boolean } = {},
): Promise<LoadedPackage | null> {
  const conditions = [eq(packages.id, id), orgOrSystemFilter(orgId)];
  if (!opts.includeEphemeral) conditions.push(notEphemeralFilter());

  const pkgRows = await db
    .select({
      id: packages.id,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
      source: packages.source,
      updatedAt: packages.updatedAt,
    })
    .from(packages)
    .where(and(...conditions))
    .limit(1);

  const pkgRow = pkgRows[0];
  if (!pkgRow) return null;

  // Deliberately does NOT resolve the skill closure. That projection depends on
  // the manifest, and a `LoadedPackage` whose manifest can later be swapped for
  // a published snapshot must not carry a projection of the draft's (#878).
  // Callers that need it derive it explicitly via `resolveDeclaredSkills`.
  return dbRowToLoadedPackage({
    id: pkgRow.id,
    draftManifest: pkgRow.draftManifest,
    draftContent: pkgRow.draftContent ?? "",
    source: pkgRow.source,
    updatedAt: pkgRow.updatedAt,
  });
}

/**
 * Load an agent and verify application-level access in one operation.
 * Default app = access to all, custom app = must be explicitly installed.
 * Returns null if agent not found OR access denied (404 semantics — no info leak).
 */
export async function getPackageWithAccess(
  id: string,
  orgId: string,
  applicationId: string,
): Promise<LoadedPackage | null> {
  const agent = await getPackage(id, orgId);
  if (!agent) return null;

  if (!(await hasPackageAccess({ orgId, applicationId }, id))) return null;

  return agent;
}

/** Get all package IDs (system + user, scoped by org). Used for collision checks. */
export async function getAllPackageIds(orgId?: string, type?: string): Promise<string[]> {
  const conditions = [notEphemeralFilter()];
  if (orgId) {
    conditions.push(orgOrSystemFilter(orgId));
  }
  if (type) {
    conditions.push(eq(packages.type, type as PackageType));
  }
  const rows = await db
    .select({ id: packages.id })
    .from(packages)
    .where(and(...conditions));

  return rows.map((r) => r.id);
}

/**
 * Check if a package exists (system or user). Ignores ephemeral shadow
 * packages — callers (scheduler, imports) never legitimately target one.
 */
export async function packageExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ cnt: count() })
    .from(packages)
    .where(and(eq(packages.id, id), notEphemeralFilter()));
  return (rows[0]?.cnt ?? 0) > 0;
}
