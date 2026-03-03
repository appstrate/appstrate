import { eq, and, inArray } from "drizzle-orm";
import { db } from "../../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";
import { parseScopedName } from "@appstrate/core/naming";
import {
  buildRegistryDepsFromRows,
  type RegistryDependencies,
} from "@appstrate/core/registry-deps";
import { type LibraryTypeConfig } from "./config.ts";
import { downloadLibraryPackage } from "./storage.ts";

// ─────────────────────────────────────────────
// Flow ↔ library item dependency management
// ─────────────────────────────────────────────

/** Replace all references of a type for a flow. Only org IDs are stored (built-in tracked via manifest). */
export async function setFlowItems(
  packageId: string,
  orgId: string,
  itemIds: string[],
  cfg: LibraryTypeConfig,
): Promise<void> {
  const orgItemIds = itemIds.filter((id) => !cfg.isBuiltIn(id));

  // Validate existence outside transaction (read-only)
  if (orgItemIds.length > 0) {
    const existing = await db
      .select({ id: packages.id })
      .from(packages)
      .where(
        and(
          eq(packages.orgId, orgId),
          eq(packages.type, cfg.type),
          inArray(packages.id, orgItemIds),
        ),
      );

    const existingIds = new Set(existing.map((e) => e.id));
    const missing = orgItemIds.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      throw new Error(`${cfg.label} not found in library: ${missing.join(", ")}`);
    }
  }

  // Delete + insert in a single transaction for atomicity
  await db.transaction(async (tx) => {
    const existingDeps = await tx
      .select({ dependencyId: packageDependencies.dependencyId })
      .from(packageDependencies)
      .innerJoin(packages, eq(packages.id, packageDependencies.dependencyId))
      .where(
        and(
          eq(packageDependencies.packageId, packageId),
          eq(packageDependencies.orgId, orgId),
          eq(packages.type, cfg.type),
        ),
      );

    const existingDepIds = existingDeps.map((d) => d.dependencyId);
    if (existingDepIds.length > 0) {
      await tx
        .delete(packageDependencies)
        .where(
          and(
            eq(packageDependencies.packageId, packageId),
            eq(packageDependencies.orgId, orgId),
            inArray(packageDependencies.dependencyId, existingDepIds),
          ),
        );
    }

    if (orgItemIds.length === 0) return;

    const rows = orgItemIds.map((depId) => ({
      packageId,
      dependencyId: depId,
      orgId,
    }));

    await tx.insert(packageDependencies).values(rows);
  });
}

/** Build registryDependencies object from a flow's current dependency links. */
export async function buildRegistryDependencies(
  packageId: string,
  orgId: string,
): Promise<RegistryDependencies | null> {
  const deps = await db
    .select({
      dependencyId: packageDependencies.dependencyId,
      type: packages.type,
      lastPublishedVersion: packages.lastPublishedVersion,
    })
    .from(packageDependencies)
    .innerJoin(packages, eq(packages.id, packageDependencies.dependencyId))
    .where(and(eq(packageDependencies.packageId, packageId), eq(packageDependencies.orgId, orgId)));

  const rows = deps.map((dep) => {
    const parsed = parseScopedName(dep.dependencyId);
    return {
      type: dep.type,
      registryScope: parsed?.scope ?? null,
      registryName: parsed?.name ?? null,
      lastPublishedVersion: dep.lastPublishedVersion,
    };
  });

  return buildRegistryDepsFromRows(rows);
}

/** Build registryDependencies from skill/extension IDs without junction table. */
export async function buildRegistryDepsFromIds(
  orgId: string,
  skillIds: string[],
  extensionIds: string[],
): Promise<RegistryDependencies | null> {
  const allIds = [...skillIds, ...extensionIds];
  if (allIds.length === 0) return null;

  const dbRows = await db
    .select({
      id: packages.id,
      type: packages.type,
      lastPublishedVersion: packages.lastPublishedVersion,
    })
    .from(packages)
    .where(and(eq(packages.orgId, orgId), inArray(packages.id, allIds)));

  const rows = dbRows.map((row) => {
    const parsed = parseScopedName(row.id);
    return {
      type: row.type,
      registryScope: parsed?.scope ?? null,
      registryName: parsed?.name ?? null,
      lastPublishedVersion: row.lastPublishedVersion,
    };
  });

  return buildRegistryDepsFromRows(rows);
}

/** Get all files for a flow's referenced items of a type. Returns Map<itemId, files>. */
export async function getFlowItemFiles(
  packageId: string,
  orgId: string,
  cfg: LibraryTypeConfig,
): Promise<Map<string, Record<string, Uint8Array>>> {
  const data = await db
    .select({ dependencyId: packageDependencies.dependencyId })
    .from(packageDependencies)
    .innerJoin(packages, eq(packages.id, packageDependencies.dependencyId))
    .where(
      and(
        eq(packageDependencies.packageId, packageId),
        eq(packageDependencies.orgId, orgId),
        eq(packages.type, cfg.type),
      ),
    );

  const entries = await Promise.all(
    data.map(async (row) => {
      const files = await downloadLibraryPackage(cfg.storageFolder, orgId, row.dependencyId);
      return [row.dependencyId, files] as const;
    }),
  );

  const result = new Map<string, Record<string, Uint8Array>>();
  for (const [id, files] of entries) {
    if (files) result.set(id, files);
  }
  return result;
}
