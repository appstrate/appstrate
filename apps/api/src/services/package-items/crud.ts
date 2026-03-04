import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { db } from "../../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";
import { extractDependencies } from "@appstrate/core/dependencies";
import { buildPackageId } from "@appstrate/core/naming";
import type { Manifest } from "@appstrate/core/validation";
import { type PackageTypeConfig } from "./config.ts";
import { deletePackageFiles } from "./storage.ts";

// ─────────────────────────────────────────────
// Helpers (private)
// ─────────────────────────────────────────────

/** Count built-in skill/extension usage from flow manifests (since built-in IDs can't be in junction tables). */
async function countBuiltInUsageFromManifests(
  orgId: string,
  cfg: PackageTypeConfig,
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
export async function listOrgItems(orgId: string, cfg: PackageTypeConfig) {
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

  const orgItems = data.map((row) => {
    const m = (row.manifest ?? {}) as Partial<Manifest>;
    return {
      id: row.id,
      orgId: row.orgId,
      name: m.displayName ?? row.name,
      description: m.description ?? null,
      source: "local" as const,
      createdBy: row.createdBy,
      createdAt: row.createdAt?.toISOString() ?? "",
      updatedAt: row.updatedAt?.toISOString() ?? "",
      usedByFlows: countMap.get(row.id) ?? 0,
    };
  });

  return [...builtInItems, ...orgItems];
}

/** Get a single item with content and list of flows referencing it. */
export async function getOrgItem(orgId: string, itemId: string, cfg: PackageTypeConfig) {
  const builtIn = cfg.resolveBuiltIn(itemId);
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

  const m = (data.manifest ?? {}) as Partial<Manifest>;
  return {
    id: data.id,
    orgId: data.orgId,
    name: m.displayName ?? data.name,
    description: m.description ?? null,
    content: data.content,
    source: "local" as const,
    createdBy: data.createdBy,
    createdAt: data.createdAt?.toISOString() ?? "",
    updatedAt: data.updatedAt?.toISOString() ?? "",
    autoInstalled: data.autoInstalled,
    lastPublishedVersion: data.lastPublishedVersion ?? null,
    lastPublishedAt: data.lastPublishedAt?.toISOString() ?? null,
    version: (m.version as string) ?? null,
    manifestName: (m.name as string) ?? null,
    manifest: (data.manifest ?? {}) as Record<string, unknown>,
    flows: await getPackageDisplayNames(packageIds),
  };
}

/** Insert or update an item in the org packages.
 *  When orgSlug is provided, packageId = @orgSlug/item.id (local creation).
 *  When orgSlug is null, item.id IS the full packageId (marketplace installs).
 *
 *  The `manifest` parameter is the source of truth (like the registry approach).
 *  When provided (ZIP upload or DB existing), it is used as-is as the base.
 *  When undefined (JSON body without manifest), a minimal default is created.
 */
export async function upsertOrgItem(
  orgId: string,
  orgSlug: string | null,
  item: UpsertItemInput,
  cfg: PackageTypeConfig,
  manifest?: Record<string, unknown>,
) {
  const now = new Date();

  const packageId = orgSlug ? `@${orgSlug}/${item.id}` : item.id;

  // Build manifest: use provided manifest as base, or create minimal default
  const finalManifest: Record<string, unknown> = manifest
    ? { ...manifest }
    : { version: "0.0.0", name: packageId };

  // Always ensure type and name
  finalManifest.type = cfg.type;
  if (!finalManifest.name) finalManifest.name = packageId;

  // Overlay displayName/description if provided
  if (item.name) finalManifest.displayName = item.name;
  if (item.description) finalManifest.description = item.description;

  const [data] = await db
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
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [packages.id],
      set: {
        manifest: finalManifest,
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
