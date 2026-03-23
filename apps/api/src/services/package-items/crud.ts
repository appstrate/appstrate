import { eq, and, or, isNull, inArray, desc, sql } from "drizzle-orm";
import { db } from "../../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";
import type { Package } from "@appstrate/db/schema";
import { extractDependencies } from "@appstrate/core/dependencies";
import { buildPackageId, parseScopedName } from "@appstrate/core/naming";
import { AFPS_SCHEMA_URLS, type Manifest } from "@appstrate/core/validation";
import { type PackageTypeConfig } from "./config.ts";
import { deletePackageFiles } from "./storage.ts";

export class PackageAlreadyExistsError extends Error {
  constructor(
    public packageId: string,
    public packageType: string,
  ) {
    super(`A ${packageType} with identifier '${packageId}' already exists`);
    this.name = "PackageAlreadyExistsError";
  }
}

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
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(inArray(packages.id, packageIds));

  return rows.map((r) => {
    const m = (
      r.draftManifest !== null &&
      typeof r.draftManifest === "object" &&
      !Array.isArray(r.draftManifest)
        ? r.draftManifest
        : {}
    ) as Partial<Manifest>;
    return {
      id: r.id,
      displayName: m.displayName ?? r.id,
    };
  });
}

/** Find registry packages that depend on the target package (via manifest dependencies). */
async function findRegistryDependents(
  orgId: string,
  targetPackageId: string,
): Promise<{ id: string; displayName: string }[]> {
  const registryPkgs = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(eq(packages.orgId, orgId));

  const dependents: { id: string; displayName: string }[] = [];
  for (const pkg of registryPkgs) {
    if (!pkg.draftManifest || pkg.id === targetPackageId) continue;
    const m = (
      pkg.draftManifest !== null &&
      typeof pkg.draftManifest === "object" &&
      !Array.isArray(pkg.draftManifest)
        ? pkg.draftManifest
        : {}
    ) as Partial<Manifest>;
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

/** Insert a new package item. `item.id` must be the fully-scoped packageId (e.g. `@scope/name`). */
export async function createOrgItem(
  orgId: string,
  item: CreateItemInput,
  cfg: PackageTypeConfig,
  manifest?: Record<string, unknown>,
  forkedFrom?: string,
): Promise<Package> {
  const now = new Date();
  const packageId = item.id;

  const finalManifest: Record<string, unknown> = manifest
    ? { ...manifest }
    : { version: "1.0.0", name: packageId };

  finalManifest.$schema = AFPS_SCHEMA_URLS[cfg.type];
  finalManifest.type = cfg.type;
  if (!finalManifest.name) finalManifest.name = packageId;
  if (item.name) finalManifest.displayName = item.name;
  if (item.description) finalManifest.description = item.description;

  // Tool packages require entrypoint + tool interface per AFPS spec
  if (cfg.type === "tool") {
    if (!finalManifest.entrypoint) finalManifest.entrypoint = "tool.ts";
    if (!finalManifest.tool) {
      const name = parseScopedName(packageId)?.name ?? item.id;
      finalManifest.tool = {
        name,
        description: item.description ?? item.name ?? name,
        inputSchema: { type: "object", properties: {} },
      };
    }
  }

  try {
    const [row] = await db
      .insert(packages)
      .values({
        id: packageId,
        orgId,
        type: cfg.type,
        source: "local",
        draftManifest: finalManifest,
        draftContent: item.content,
        createdBy: item.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
        forkedFrom: forkedFrom ?? null,
      })
      .returning();

    if (!row) throw new Error("Failed to insert package: no row returned");
    return row;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as { code: string }).code === "23505") {
      // Look up the existing package's type for a helpful error message
      const [existing] = await db
        .select({ type: packages.type })
        .from(packages)
        .where(eq(packages.id, packageId))
        .limit(1);
      throw new PackageAlreadyExistsError(packageId, existing?.type ?? cfg.type);
    }
    throw err;
  }
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
      draftManifest: payload.manifest,
      draftContent: payload.content,
      updatedAt: new Date(),
      lockVersion: sql`${packages.lockVersion} + 1`,
    })
    .where(and(eq(packages.id, id), eq(packages.lockVersion, expectedVersion)))
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
    const m = (
      row.draftManifest !== null &&
      typeof row.draftManifest === "object" &&
      !Array.isArray(row.draftManifest)
        ? row.draftManifest
        : {}
    ) as Partial<Manifest>;
    return {
      id: row.id,
      orgId: row.orgId,
      name: m.displayName ?? row.id,
      description: m.description ?? null,
      source: row.source ?? "local",
      createdBy: row.createdBy,
      createdAt: row.createdAt?.toISOString() ?? "",
      updatedAt: row.updatedAt?.toISOString() ?? "",
      usedByFlows: countMap.get(row.id) ?? 0,
      version: typeof m.version === "string" ? m.version : null,
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

  const m = (
    data.draftManifest !== null &&
    typeof data.draftManifest === "object" &&
    !Array.isArray(data.draftManifest)
      ? data.draftManifest
      : {}
  ) as Partial<Manifest>;
  return {
    id: data.id,
    orgId: data.orgId,
    name: m.displayName ?? data.id,
    description: m.description ?? null,
    content: data.draftContent,
    source: data.source ?? "local",
    createdBy: data.createdBy,
    createdAt: data.createdAt?.toISOString() ?? "",
    updatedAt: data.updatedAt?.toISOString() ?? "",
    autoInstalled: data.autoInstalled,
    version: typeof m.version === "string" ? m.version : null,
    manifestName: typeof m.name === "string" ? m.name : null,
    manifest: (data.draftManifest !== null &&
    typeof data.draftManifest === "object" &&
    !Array.isArray(data.draftManifest)
      ? data.draftManifest
      : {}) as Record<string, unknown>,
    lockVersion: data.lockVersion,
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

  const dependents = await findRegistryDependents(orgId, itemId);
  if (dependents.length > 0) {
    return { ok: false, error: "DEPENDED_ON", dependents };
  }

  await db
    .delete(packages)
    .where(and(eq(packages.orgId, orgId), eq(packages.id, itemId), eq(packages.type, cfg.type)));

  await deletePackageFiles(cfg.storageFolder, orgId, itemId);

  return { ok: true };
}
