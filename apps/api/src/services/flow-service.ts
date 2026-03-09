import { eq, and, or, isNull, count, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";
import type { Manifest } from "@appstrate/core/validation";
import type { FlowManifest, LoadedFlow } from "../types/index.ts";

interface DbPackageRow {
  id: string;
  manifest: unknown;
  content: string;
  source?: string;
  depRefs?: {
    dependencyId: string;
    type: string;
    manifest: unknown;
  }[];
}

function dbRowToLoadedFlow(row: DbPackageRow): LoadedFlow {
  const manifest = (row.manifest ?? {
    schemaVersion: "1.0",
    name: row.id,
    version: "0.0.0",
    type: "flow",
    displayName: row.id,
    description: "",
    author: "",
    requires: { providers: {} },
  }) as FlowManifest;

  // Read version maps from the flow's manifest
  const manifestSkillsMap = (manifest.requires.skills ?? {}) as Record<string, string>;
  const manifestExtensionsMap = (manifest.requires.extensions ?? {}) as Record<string, string>;

  // Dependencies from packageDependencies joined with packages
  const depSkills = (row.depRefs ?? [])
    .filter((d) => d.type === "skill")
    .map((d) => {
      const m = (d.manifest ?? {}) as Partial<Manifest>;
      return {
        id: d.dependencyId,
        version: manifestSkillsMap[d.dependencyId] ?? "*",
        name: m.displayName ?? undefined,
        description: m.description ?? undefined,
      };
    });

  const depExtensions = (row.depRefs ?? [])
    .filter((d) => d.type === "extension")
    .map((d) => {
      const m = (d.manifest ?? {}) as Partial<Manifest>;
      return {
        id: d.dependencyId,
        version: manifestExtensionsMap[d.dependencyId] ?? "*",
        name: m.displayName ?? undefined,
        description: m.description ?? undefined,
      };
    });

  return {
    id: row.id,
    manifest,
    prompt: row.content,
    skills: depSkills,
    extensions: depExtensions,
    source: (row.source as "system" | "local") ?? "local",
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
      manifest: packages.manifest,
      content: packages.content,
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
      manifest: packages.manifest,
    })
    .from(packageDependencies)
    .innerJoin(packages, eq(packageDependencies.dependencyId, packages.id))
    .where(eq(packageDependencies.packageId, id));

  return dbRowToLoadedFlow({
    id: pkgRow.id,
    manifest: pkgRow.manifest,
    content: pkgRow.content ?? "",
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
      manifest: packages.manifest,
      content: packages.content,
      source: packages.source,
    })
    .from(packages)
    .where(and(...conditions))
    .orderBy(sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`);

  return rows.map((row) =>
    dbRowToLoadedFlow({
      id: row.id,
      manifest: row.manifest,
      content: row.content ?? "",
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
    conditions.push(eq(packages.type, type as "flow" | "skill" | "extension"));
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
