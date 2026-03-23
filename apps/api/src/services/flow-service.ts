import { eq, and, or, isNull, count, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";
import type { Manifest } from "@appstrate/core/validation";
import type { PackageType } from "./package-items/config.ts";
import type { FlowManifest, LoadedFlow } from "../types/index.ts";

function asRecord(val: unknown): Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

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

function dbRowToLoadedFlow(row: DbPackageRow): LoadedFlow {
  const manifest = asRecord(row.draftManifest) as FlowManifest;

  // Read version maps from the flow's manifest
  const manifestSkillsMap = (manifest.dependencies?.skills ?? {}) as Record<string, string>;
  const manifestToolsMap = (manifest.dependencies?.tools ?? {}) as Record<string, string>;

  // Dependencies from packageDependencies joined with packages
  const depSkills = (row.depRefs ?? [])
    .filter((d) => d.type === "skill")
    .map((d) => {
      const m = asRecord(d.draftManifest) as Partial<Manifest>;
      return {
        id: d.dependencyId,
        version: manifestSkillsMap[d.dependencyId] ?? "*",
        name: m.displayName ?? undefined,
        description: m.description ?? undefined,
      };
    });

  const depTools = (row.depRefs ?? [])
    .filter((d) => d.type === "tool")
    .map((d) => {
      const m = asRecord(d.draftManifest) as Partial<Manifest>;
      return {
        id: d.dependencyId,
        version: manifestToolsMap[d.dependencyId] ?? "*",
        name: m.displayName ?? undefined,
        description: m.description ?? undefined,
      };
    });

  return {
    id: row.id,
    manifest,
    prompt: row.draftContent,
    skills: depSkills,
    tools: depTools,
    source: row.source === "system" || row.source === "local" ? row.source : "local",
  };
}

/** Get a single package by ID. Queries DB filtered by orgId (includes system packages via orgId: null). */
export async function getPackage(id: string, orgId?: string): Promise<LoadedFlow | null> {
  const conditions = [eq(packages.id, id)];
  if (orgId) {
    conditions.push(or(eq(packages.orgId, orgId), isNull(packages.orgId))!);
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

  // Fetch dependencies joined with their package metadata
  const depRefs = await db
    .select({
      dependencyId: packageDependencies.dependencyId,
      type: packages.type,
      draftManifest: packages.draftManifest,
    })
    .from(packageDependencies)
    .innerJoin(packages, eq(packageDependencies.dependencyId, packages.id))
    .where(eq(packageDependencies.packageId, id));

  return dbRowToLoadedFlow({
    id: pkgRow.id,
    draftManifest: pkgRow.draftManifest,
    draftContent: pkgRow.draftContent ?? "",
    source: pkgRow.source,
    depRefs,
  });
}

/** List all flows: system (orgId: null) + user packages of type "flow" (from DB, scoped by org). */
export async function listPackages(orgId?: string): Promise<LoadedFlow[]> {
  const conditions = [eq(packages.type, "flow")];
  if (orgId) {
    conditions.push(or(eq(packages.orgId, orgId), isNull(packages.orgId))!);
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
    dbRowToLoadedFlow({
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
    conditions.push(or(eq(packages.orgId, orgId), isNull(packages.orgId))!);
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
