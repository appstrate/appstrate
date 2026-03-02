import { eq, and, inArray, desc, sql, isNotNull } from "drizzle-orm";
import { db } from "../../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";
import { extractDependencies } from "@appstrate/validation/dependencies";
import { depEntryToPackageId } from "@appstrate/validation/naming";
import { type LibraryTypeConfig } from "./config.ts";
import { deleteLibraryPackage } from "./storage.ts";

// ─────────────────────────────────────────────
// Helpers (private)
// ─────────────────────────────────────────────

/** Count built-in skill/extension usage from flow manifests (since built-in IDs can't be in junction tables). */
async function countBuiltInUsageFromManifests(
  orgId: string,
  cfg: LibraryTypeConfig,
): Promise<Map<string, number>> {
  const flowRows = await db
    .select({ manifest: packages.manifest })
    .from(packages)
    .where(and(eq(packages.orgId, orgId), eq(packages.type, "flow")));

  const countMap = new Map<string, number>();

  for (const flow of flowRows) {
    const manifest = flow.manifest as { requires?: { [k: string]: { id: string }[] } };
    const items = manifest?.requires?.[cfg.storageFolder] ?? [];
    for (const item of items) {
      if (cfg.isBuiltIn(item.id)) {
        countMap.set(item.id, (countMap.get(item.id) ?? 0) + 1);
      }
    }
  }
  return countMap;
}

/** Fetch package display names from a list of package IDs. */
async function getPackageDisplayNames(
  packageIds: string[],
): Promise<{ id: string; displayName: string }[]> {
  if (packageIds.length === 0) return [];
  const rows = await db
    .select({ id: packages.id, displayName: packages.displayName })
    .from(packages)
    .where(inArray(packages.id, packageIds));

  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName ?? r.id,
  }));
}

/** Find registry packages that depend on the target package (via manifest registryDependencies). */
async function findRegistryDependents(
  orgId: string,
  targetPackageId: string,
): Promise<{ id: string; displayName: string }[]> {
  const registryPkgs = await db
    .select({ id: packages.id, displayName: packages.displayName, manifest: packages.manifest })
    .from(packages)
    .where(and(eq(packages.orgId, orgId), isNotNull(packages.registryScope)));

  const dependents: { id: string; displayName: string }[] = [];
  for (const pkg of registryPkgs) {
    if (!pkg.manifest || pkg.id === targetPackageId) continue;
    const deps = extractDependencies(pkg.manifest as Record<string, unknown>);
    for (const dep of deps) {
      if (depEntryToPackageId(dep.depScope, dep.depName) === targetPackageId) {
        dependents.push({ id: pkg.id, displayName: pkg.displayName ?? pkg.id });
        break;
      }
    }
  }
  return dependents;
}

// ─────────────────────────────────────────────
// Unified CRUD functions
// ─────────────────────────────────────────────

export interface UpsertItemInput {
  id: string;
  name?: string;
  description?: string;
  content: string;
  createdBy?: string;
}

/** List all items of a type in the org with usedByFlows count (built-in + org). */
export async function listOrgItems(orgId: string, cfg: LibraryTypeConfig) {
  const data = await db
    .select()
    .from(packages)
    .where(
      and(
        eq(packages.orgId, orgId),
        eq(packages.type, cfg.type),
        eq(packages.autoInstalled, false),
      ),
    )
    .orderBy(desc(packages.createdAt));

  const depRows = await db
    .select({ dependencyId: packageDependencies.dependencyId })
    .from(packageDependencies)
    .where(eq(packageDependencies.orgId, orgId));

  const countMap = new Map<string, number>();
  for (const row of depRows) {
    countMap.set(row.dependencyId, (countMap.get(row.dependencyId) ?? 0) + 1);
  }

  const builtInCounts = await countBuiltInUsageFromManifests(orgId, cfg);

  const orgItemIds = new Set(data.map((row) => row.id));

  const builtInItems = [...cfg.getBuiltIns().values()]
    .filter((item) => !orgItemIds.has(item.id))
    .map((item) => ({
      id: item.id,
      orgId: null as string | null,
      name: item.name,
      description: item.description,
      source: "built-in" as const,
      createdBy: null as string | null,
      createdAt: "",
      updatedAt: "",
      usedByFlows: builtInCounts.get(item.id) ?? 0,
    }));

  const orgItems = data.map((row) => ({
    id: row.id,
    orgId: row.orgId,
    name: row.displayName ?? row.name,
    description: row.description,
    source: "local" as const,
    createdBy: row.createdBy,
    createdAt: row.createdAt?.toISOString() ?? "",
    updatedAt: row.updatedAt?.toISOString() ?? "",
    usedByFlows: countMap.get(row.id) ?? 0,
  }));

  return [...builtInItems, ...orgItems];
}

/** Get a single item with content and list of flows referencing it. */
export async function getOrgItem(orgId: string, itemId: string, cfg: LibraryTypeConfig) {
  const builtIn = cfg.getBuiltIns().get(itemId);
  if (builtIn) {
    return {
      id: builtIn.id,
      orgId: null as string | null,
      name: builtIn.name,
      description: builtIn.description,
      content: builtIn.content,
      source: "built-in" as const,
      createdBy: null as string | null,
      createdAt: "",
      updatedAt: "",
      flows: [],
    };
  }

  const [data] = await db
    .select()
    .from(packages)
    .where(and(eq(packages.orgId, orgId), eq(packages.id, itemId), eq(packages.type, cfg.type)))
    .limit(1);

  if (!data) return null;

  const depRefs = await db
    .select({ packageId: packageDependencies.packageId })
    .from(packageDependencies)
    .where(and(eq(packageDependencies.orgId, orgId), eq(packageDependencies.dependencyId, itemId)));

  const packageIds = depRefs.map((d) => d.packageId);

  return {
    id: data.id,
    orgId: data.orgId,
    name: data.displayName ?? data.name,
    description: data.description,
    content: data.content,
    source: "local" as const,
    createdBy: data.createdBy,
    createdAt: data.createdAt?.toISOString() ?? "",
    updatedAt: data.updatedAt?.toISOString() ?? "",
    registryScope: data.registryScope ?? null,
    registryName: data.registryName ?? null,
    autoInstalled: data.autoInstalled,
    flows: await getPackageDisplayNames(packageIds),
  };
}

/** Insert or update an item in the org library. */
export async function upsertOrgItem(orgId: string, item: UpsertItemInput, cfg: LibraryTypeConfig) {
  const now = new Date();

  const [data] = await db
    .insert(packages)
    .values({
      id: item.id,
      orgId,
      type: cfg.type,
      source: "local",
      name: item.id,
      displayName: item.name ?? null,
      description: item.description ?? null,
      content: item.content,
      createdBy: item.createdBy ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [packages.id],
      set: {
        displayName: item.name ?? null,
        description: item.description ?? null,
        content: item.content,
        createdBy: item.createdBy ?? null,
        updatedAt: now,
      },
      setWhere: eq(packages.orgId, sql`excluded.org_id`),
    })
    .returning();

  return data!;
}

/** Delete an item. Returns error info if still referenced by flows. */
export async function deleteOrgItem(
  orgId: string,
  itemId: string,
  cfg: LibraryTypeConfig,
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

  await deleteLibraryPackage(cfg.storageFolder, orgId, itemId);

  return { ok: true };
}
