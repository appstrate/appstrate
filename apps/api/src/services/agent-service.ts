// SPDX-License-Identifier: Apache-2.0

import { eq, and, count, sql, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import type { Manifest } from "@appstrate/core/validation";
import type { PackageType } from "@appstrate/core/validation";
import type { AgentManifest, LoadedPackage } from "../types/index.ts";
import { asRecord } from "../lib/safe-json.ts";
import { orgOrSystemFilter } from "../lib/package-helpers.ts";
import { extractDepsFromManifest } from "../lib/manifest-utils.ts";

interface DbPackageRow {
  id: string;
  draftManifest: unknown;
  draftContent: string;
  source?: string;
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
      const m = asRecord(d.draftManifest) as Partial<Manifest>;
      return {
        id: d.dependencyId,
        version: versionMap[d.dependencyId] ?? "*",
        name: m.displayName ?? undefined,
        description: m.description ?? undefined,
      };
    });
}

function dbRowToLoadedPackage(row: DbPackageRow): LoadedPackage {
  const manifest = asRecord(row.draftManifest) as AgentManifest;
  const deps = row.depRefs ?? [];

  return {
    id: row.id,
    manifest,
    prompt: row.draftContent,
    skills: mapDependencies(
      deps,
      "skill",
      (manifest.dependencies?.skills ?? {}) as Record<string, string>,
    ),
    tools: mapDependencies(
      deps,
      "tool",
      (manifest.dependencies?.tools ?? {}) as Record<string, string>,
    ),
    source: (row.source as "system" | "local") ?? "local",
  };
}

/** Resolve dependency refs from a package's manifest. */
async function resolveDepRefs(manifest: unknown): Promise<NonNullable<DbPackageRow["depRefs"]>> {
  const m = asRecord(manifest) as Partial<Manifest>;
  const { skillIds, toolIds, providerIds } = extractDepsFromManifest(m);
  const allDepIds = [...skillIds, ...toolIds, ...providerIds];
  if (allDepIds.length === 0) return [];

  const rows = await db
    .select({
      id: packages.id,
      type: packages.type,
      draftManifest: packages.draftManifest,
    })
    .from(packages)
    .where(inArray(packages.id, allDepIds));

  return rows.map((r) => ({
    dependencyId: r.id,
    type: r.type,
    draftManifest: r.draftManifest,
  }));
}

/** Get a single package by ID. Queries DB filtered by orgId (includes system packages via orgId: null). */
export async function getPackage(id: string, orgId?: string): Promise<LoadedPackage | null> {
  const conditions = [eq(packages.id, id)];
  if (orgId) {
    conditions.push(orgOrSystemFilter(orgId));
  }

  const pkgRows = await db
    .select({
      id: packages.id,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
      source: packages.source,
    })
    .from(packages)
    .where(and(...conditions))
    .limit(1);

  const pkgRow = pkgRows[0];
  if (!pkgRow) return null;

  const depRefs = await resolveDepRefs(pkgRow.draftManifest);

  return dbRowToLoadedPackage({
    id: pkgRow.id,
    draftManifest: pkgRow.draftManifest,
    draftContent: pkgRow.draftContent ?? "",
    source: pkgRow.source,
    depRefs,
  });
}

/** List all agents: system (orgId: null) + user packages of type "agent" (from DB, scoped by org). */
export async function listPackages(orgId?: string): Promise<LoadedPackage[]> {
  const conditions = [eq(packages.type, "agent")];
  if (orgId) {
    conditions.push(orgOrSystemFilter(orgId));
  }
  const rows = await db
    .select({
      id: packages.id,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
      source: packages.source,
    })
    .from(packages)
    .where(and(...conditions))
    .orderBy(sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`);

  return rows.map((row) =>
    dbRowToLoadedPackage({
      id: row.id,
      draftManifest: row.draftManifest,
      draftContent: row.draftContent ?? "",
      source: row.source,
    }),
  );
}

/** Get all package IDs (system + user, scoped by org). Used for collision checks. */
export async function getAllPackageIds(orgId?: string, type?: string): Promise<string[]> {
  const conditions = [];
  if (orgId) {
    conditions.push(orgOrSystemFilter(orgId));
  }
  if (type) {
    conditions.push(eq(packages.type, type as PackageType));
  }
  const rows = await db
    .select({ id: packages.id })
    .from(packages)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return rows.map((r) => r.id);
}

/** Check if a package exists (system or user). */
export async function packageExists(id: string): Promise<boolean> {
  const rows = await db.select({ cnt: count() }).from(packages).where(eq(packages.id, id));
  return (rows[0]?.cnt ?? 0) > 0;
}
