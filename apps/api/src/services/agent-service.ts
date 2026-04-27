// SPDX-License-Identifier: Apache-2.0

import { eq, and, count, sql, or, inArray, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import type { PackageType } from "@appstrate/core/validation";
import { caretRange } from "@appstrate/core/semver";
import type { AgentManifest, LoadedPackage } from "../types/index.ts";
import { asRecord } from "@appstrate/core/safe-json";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { extractDepsFromManifest, parseDraftManifest } from "../lib/manifest-utils.ts";
import { hasPackageAccess } from "./application-packages.ts";

interface DbPackageRow {
  id: string;
  draftManifest: unknown;
  draftContent: string;
  source?: string;
  updatedAt?: Date;
  depRefs?: {
    dependencyId: string;
    type: string;
    draftManifest: unknown;
  }[];
}

function mapDependencies(
  depRefs: NonNullable<DbPackageRow["depRefs"]>,
  type: string,
  versionMap: Record<string, string>,
): LoadedPackage["skills"] {
  return depRefs
    .filter((d) => d.type === type)
    .map((d) => {
      const m = parseDraftManifest(d.draftManifest);
      // Manifest's declared range is the source of truth. If the
      // manifest doesn't carry one for a dep that resolved (data
      // inconsistency — extractDepsFromManifest reads the same
      // section), fall back to caret-of-current so we never emit a
      // bare wildcard. `m.version` is "0.0.0" only for malformed
      // drafts, in which case the dep wouldn't load at runtime anyway.
      return {
        id: d.dependencyId,
        version: versionMap[d.dependencyId] ?? caretRange(m.version ?? "0.0.0"),
        name: m.displayName ?? undefined,
        description: m.description ?? undefined,
      };
    });
}

function pickSkillsAndTools(
  depRefs: NonNullable<DbPackageRow["depRefs"]>,
  manifest: AgentManifest,
): Pick<LoadedPackage, "skills" | "tools"> {
  const deps = manifest.dependencies ?? {};
  return {
    skills: mapDependencies(depRefs, "skill", (deps.skills ?? {}) as Record<string, string>),
    tools: mapDependencies(depRefs, "tool", (deps.tools ?? {}) as Record<string, string>),
  };
}

function dbRowToLoadedPackage(row: DbPackageRow): LoadedPackage {
  const manifest = asRecord(row.draftManifest) as AgentManifest;
  return {
    id: row.id,
    manifest,
    prompt: row.draftContent,
    ...pickSkillsAndTools(row.depRefs ?? [], manifest),
    source: (row.source as "system" | "local") ?? "local",
    updatedAt: row.updatedAt,
  };
}

/** Resolve dependency refs from a package's manifest. */
async function resolveDepRefs(
  manifest: unknown,
  orgId: string,
): Promise<NonNullable<DbPackageRow["depRefs"]>> {
  const m = parseDraftManifest(manifest);
  const { skillIds, toolIds, providerIds } = extractDepsFromManifest(m);
  const allDepIds = [...skillIds, ...toolIds, ...providerIds];
  if (allDepIds.length === 0) return [];

  const conditions = [inArray(packages.id, allDepIds), orgOrSystemFilter(orgId)];

  const rows = await db
    .select({
      id: packages.id,
      type: packages.type,
      draftManifest: packages.draftManifest,
    })
    .from(packages)
    .where(and(...conditions));

  return rows.map((r) => ({
    dependencyId: r.id,
    type: r.type,
    draftManifest: r.draftManifest,
  }));
}

/**
 * Resolve the skills + tools declared in an inline manifest's `dependencies`
 * against the org/system catalog. Inline manifests only embed ID refs
 * (`"@scope/name": "^1.0.0"`), so the shadow LoadedPackage needs the same
 * mapped-dep shape as a persisted package before it reaches
 * `validateAgentReadiness`. Returns empty arrays when the manifest declares
 * no skill/tool deps — no DB read happens in that case.
 */
export async function resolveManifestCatalogDeps(
  manifest: AgentManifest,
  orgId: string,
): Promise<Pick<LoadedPackage, "skills" | "tools">> {
  const depRefs = await resolveDepRefs(manifest, orgId);
  return pickSkillsAndTools(depRefs, manifest);
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

  const depRefs = await resolveDepRefs(pkgRow.draftManifest, orgId);

  return dbRowToLoadedPackage({
    id: pkgRow.id,
    draftManifest: pkgRow.draftManifest,
    draftContent: pkgRow.draftContent ?? "",
    source: pkgRow.source,
    updatedAt: pkgRow.updatedAt,
    depRefs,
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

/**
 * Select packages scoped to `orgId` (system + user) with shared projection,
 * `notEphemeral` + type filter, and the system-first ordering. Callers pass
 * additional `where` predicates and an optional row cap; everything else is
 * held constant so `listPackages` and `searchPackages` stay in lockstep.
 */
async function selectScopedPackages(args: {
  orgId: string;
  type: PackageType;
  extra?: SQL;
  limit?: number;
}): Promise<LoadedPackage[]> {
  const conditions = [
    eq(packages.type, args.type),
    orgOrSystemFilter(args.orgId),
    notEphemeralFilter(),
  ];
  if (args.extra) conditions.push(args.extra);

  const q = db
    .select({
      id: packages.id,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
      source: packages.source,
    })
    .from(packages)
    .where(and(...conditions))
    .orderBy(sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`);

  const rows = args.limit != null ? await q.limit(args.limit) : await q;

  return rows.map((row) =>
    dbRowToLoadedPackage({
      id: row.id,
      draftManifest: row.draftManifest,
      draftContent: row.draftContent ?? "",
      source: row.source,
    }),
  );
}

/**
 * Free-text catalog search for external modules via PlatformServices.
 * Matches `id` and manifest fields (`name`, `displayName`, `description`)
 * with Postgres `ILIKE` — fine for the few-hundred-packages-per-org
 * scale; a full-text index can be bolted on later if volume grows.
 *
 * Callers pass their target `limit`; this function returns at most
 * `limit + 1` rows so the caller can derive `hasMore` without a
 * separate COUNT. Default limit is capped to keep the contract bounded.
 */
export async function searchPackages(args: {
  query: string;
  orgId: string;
  kind: PackageType;
  /** Soft-capped at 100 to keep the contract bounded. Default 10. */
  limit?: number;
}): Promise<LoadedPackage[]> {
  const limit = Math.min(args.limit ?? 10, 100);
  const pattern = `%${args.query}%`;

  return selectScopedPackages({
    orgId: args.orgId,
    type: args.kind,
    extra: or(
      sql`${packages.id} ILIKE ${pattern}`,
      sql`${packages.draftManifest}->>'name' ILIKE ${pattern}`,
      sql`${packages.draftManifest}->>'displayName' ILIKE ${pattern}`,
      sql`${packages.draftManifest}->>'description' ILIKE ${pattern}`,
    ),
    limit: limit + 1,
  });
}

/** List packages by type: system (orgId: null) + user packages (from DB, scoped by org). Defaults to "agent". */
export async function listPackages(
  orgId: string,
  type: PackageType = "agent",
): Promise<LoadedPackage[]> {
  return selectScopedPackages({ orgId, type });
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
