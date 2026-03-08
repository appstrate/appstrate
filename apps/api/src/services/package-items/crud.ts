import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { db } from "../../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";
import type { Package } from "@appstrate/db/schema";
import { extractDependencies } from "@appstrate/core/dependencies";
import { buildPackageId } from "@appstrate/core/naming";
import type { Manifest } from "@appstrate/core/validation";
import { type PackageTypeConfig } from "./config.ts";
import { deletePackageFiles } from "./storage.ts";

// ─────────────────────────────────────────────
// Generic package lookup
// ─────────────────────────────────────────────

/** Get a raw package row by ID (no org filter — used for import collision checks). */
export async function getPackageById(id: string): Promise<Package | null> {
  const rows = await db.select().from(packages).where(eq(packages.id, id)).limit(1);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────
// Helpers (private)
// ─────────────────────────────────────────────

/** Fetch package display names from a list of package IDs. */
async function getPackageDisplayNames(
  packageIds: string[],
): Promise<{ id: string; displayName: string }[]> {
  if (packageIds.length === 0) return [];
  const rows = await db
    .select({ id: packages.id, manifest: packages.manifest })
    .from(packages)
    .where(inArray(packages.id, packageIds));

  return rows.map((r) => {
    const m = (r.manifest ?? {}) as Partial<Manifest>;
    return {
      id: r.id,
      displayName: m.displayName ?? r.id,
    };
  });
}

/** Find registry packages that depend on the target package (via manifest registryDependencies). */
async function findRegistryDependents(
  orgId: string,
  targetPackageId: string,
): Promise<{ id: string; displayName: string }[]> {
  const registryPkgs = await db
    .select({ id: packages.id, manifest: packages.manifest })
    .from(packages)
    .where(eq(packages.orgId, orgId));

  const dependents: { id: string; displayName: string }[] = [];
  for (const pkg of registryPkgs) {
    if (!pkg.manifest || pkg.id === targetPackageId) continue;
    const m = pkg.manifest as Partial<Manifest>;
    const deps = extractDependencies(m);
    for (const dep of deps) {
      if (buildPackageId(dep.depScope, dep.depName) === targetPackageId) {
        dependents.push({ id: pkg.id, displayName: m.displayName ?? pkg.id });
        break;
      }
    }
  }
  return dependents;
}

// ─────────────────────────────────────────────
// Create / Update with optimistic locking
// ─────────────────────────────────────────────

export interface CreateItemInput {
  id: string;
  name?: string;
  description?: string;
  content: string;
  createdBy?: string;
}

/** Insert a new package item. Returns the row with version=1 (lock counter). */
export async function createOrgItem(
  orgId: string,
  orgSlug: string | null,
  item: CreateItemInput,
  cfg: PackageTypeConfig,
  manifest?: Record<string, unknown>,
  forkedFrom?: string,
): Promise<Package> {
  const now = new Date();
  const packageId = orgSlug ? `@${orgSlug}/${item.id}` : item.id;

  const finalManifest: Record<string, unknown> = manifest
    ? { ...manifest }
    : { version: "1.0.0", name: packageId };

  finalManifest.type = cfg.type;
  if (!finalManifest.name) finalManifest.name = packageId;
  if (item.name) finalManifest.displayName = item.name;
  if (item.description) finalManifest.description = item.description;

  const [row] = await db
    .insert(packages)
    .values({
      id: packageId,
      orgId,
      type: cfg.type,
      source: "local",
      name: item.id,
      manifest: finalManifest,
      content: item.content,
      createdBy: item.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      forkedFrom: forkedFrom ?? null,
    })
    .returning();

  if (!row) throw new Error("Failed to insert package: no row returned");
  return row;
}

/** Update a package item with optimistic locking. Returns null on version mismatch (409). */
export async function updateOrgItem(
  id: string,
  payload: {
    manifest: Record<string, unknown>;
    content: string;
  },
  expectedVersion: number,
): Promise<Package | null> {
  const rows = await db
    .update(packages)
    .set({
      manifest: payload.manifest,
      content: payload.content,
      updatedAt: new Date(),
      version: sql`${packages.version} + 1`,
    })
    .where(and(eq(packages.id, id), eq(packages.version, expectedVersion)))
    .returning();

  return rows[0] ?? null;
}

/** List all items of a type in the org with usedByFlows count. */
export async function listOrgItems(orgId: string, cfg: PackageTypeConfig) {
  const orgFilter = or(eq(packages.orgId, orgId), isNull(packages.orgId));

  const data = await db
    .select()
    .from(packages)
    .where(and(orgFilter, eq(packages.type, cfg.type)))
    .orderBy(
      sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`,
      desc(packages.createdAt),
    );

  // Count usage via packageDependencies junction table (unified for all types)
  const countMap = new Map<string, number>();
  const depRows = await db
    .select({ dependencyId: packageDependencies.dependencyId })
    .from(packageDependencies)
    .where(eq(packageDependencies.orgId, orgId));
  for (const row of depRows) {
    countMap.set(row.dependencyId, (countMap.get(row.dependencyId) ?? 0) + 1);
  }

  return data.map((row) => {
    const m = (row.manifest ?? {}) as Partial<Manifest>;
    return {
      id: row.id,
      orgId: row.orgId,
      name: m.displayName ?? row.name,
      description: m.description ?? null,
      source: row.source ?? "local",
      createdBy: row.createdBy,
      createdAt: row.createdAt?.toISOString() ?? "",
      updatedAt: row.updatedAt?.toISOString() ?? "",
      usedByFlows: countMap.get(row.id) ?? 0,
      version: (m.version as string) ?? null,
      autoInstalled: row.autoInstalled,
      forkedFrom: row.forkedFrom ?? null,
    };
  });
}

/** Get a single item with content and list of flows referencing it. */
export async function getOrgItem(orgId: string, itemId: string, cfg: PackageTypeConfig) {
  const orgFilter = or(eq(packages.orgId, orgId), isNull(packages.orgId));

  const [data] = await db
    .select()
    .from(packages)
    .where(and(orgFilter, eq(packages.id, itemId), eq(packages.type, cfg.type)))
    .limit(1);

  if (!data) return null;

  const depRefs = await db
    .select({ packageId: packageDependencies.packageId })
    .from(packageDependencies)
    .where(and(eq(packageDependencies.orgId, orgId), eq(packageDependencies.dependencyId, itemId)));

  const packageIds = depRefs.map((d) => d.packageId);

  const m = (data.manifest ?? {}) as Partial<Manifest>;
  return {
    id: data.id,
    orgId: data.orgId,
    name: m.displayName ?? data.name,
    description: m.description ?? null,
    content: data.content,
    source: data.source ?? "local",
    createdBy: data.createdBy,
    createdAt: data.createdAt?.toISOString() ?? "",
    updatedAt: data.updatedAt?.toISOString() ?? "",
    autoInstalled: data.autoInstalled,
    version: (m.version as string) ?? null,
    manifestName: (m.name as string) ?? null,
    manifest: (data.manifest ?? {}) as Record<string, unknown>,
    lockVersion: data.version,
    forkedFrom: data.forkedFrom ?? null,
    flows: await getPackageDisplayNames(packageIds),
  };
}

/** Delete an item. Returns error info if still referenced by flows. */
export async function deleteOrgItem(
  orgId: string,
  itemId: string,
  cfg: PackageTypeConfig,
): Promise<{
  ok: boolean;
  error?: string;
  flows?: { id: string; displayName: string }[];
  dependents?: { id: string; displayName: string }[];
}> {
  const refs = await db
    .select({ packageId: packageDependencies.packageId })
    .from(packageDependencies)
    .where(and(eq(packageDependencies.orgId, orgId), eq(packageDependencies.dependencyId, itemId)));

  if (refs.length > 0) {
    const flowList = await getPackageDisplayNames(refs.map((r) => r.packageId));
    return { ok: false, error: "IN_USE", flows: flowList };
  }

  const registryDeps = await findRegistryDependents(orgId, itemId);
  if (registryDeps.length > 0) {
    return { ok: false, error: "DEPENDED_ON", dependents: registryDeps };
  }

  await db
    .delete(packages)
    .where(and(eq(packages.orgId, orgId), eq(packages.id, itemId), eq(packages.type, cfg.type)));

  await deletePackageFiles(cfg.storageFolder, orgId, itemId);

  return { ok: true };
}
