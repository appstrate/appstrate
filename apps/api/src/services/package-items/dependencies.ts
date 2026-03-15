import { eq, and, or, inArray, isNull } from "drizzle-orm";
import { db } from "../../lib/db.ts";
import { packages, packageDependencies } from "@appstrate/db/schema";
import { parseScopedName } from "@appstrate/core/naming";
import {
  buildRegistryDepsFromRows,
  type RegistryDependencies,
} from "@appstrate/core/registry-deps";
import { type PackageTypeConfig, SKILL_CONFIG, TOOL_CONFIG, PROVIDER_CONFIG } from "./config.ts";
import { downloadPackageFiles } from "./storage.ts";

// ─────────────────────────────────────────────
// Flow ↔ package item dependency management
// ─────────────────────────────────────────────

/** Replace all references of a type for a flow. */
export async function setFlowItems(
  packageId: string,
  orgId: string,
  itemIds: string[],
  cfg: PackageTypeConfig,
): Promise<void> {
  const orgItemIds = itemIds;

  // Validate existence outside transaction (read-only)
  if (orgItemIds.length > 0) {
    const existing = await db
      .select({ id: packages.id })
      .from(packages)
      .where(
        and(
          or(eq(packages.orgId, orgId), isNull(packages.orgId)),
          eq(packages.type, cfg.type),
          inArray(packages.id, orgItemIds),
        ),
      );

    const existingIds = new Set(existing.map((e) => e.id));
    const missing = orgItemIds.filter((id) => !existingIds.has(id));
    if (missing.length > 0) {
      throw new Error(`${cfg.label} not found in packages: ${missing.join(", ")}`);
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

/** Synchronise the junction table after save (flows only). */
export async function syncFlowDepsJunctionTable(
  packageId: string,
  orgId: string,
  skillIds: string[],
  toolIds: string[],
  providerIds: string[],
): Promise<void> {
  await setFlowItems(packageId, orgId, skillIds, SKILL_CONFIG);
  await setFlowItems(packageId, orgId, toolIds, TOOL_CONFIG);
  await setFlowItems(packageId, orgId, providerIds, PROVIDER_CONFIG);
}

/** Build registryDependencies object from a flow's current dependency links.
 *  Now that providers are in packageDependencies, the join query picks them up automatically. */
export async function buildRegistryDependencies(
  packageId: string,
  orgId: string,
): Promise<RegistryDependencies | null> {
  const deps = await db
    .select({
      dependencyId: packageDependencies.dependencyId,
      type: packages.type,
      draftManifest: packages.draftManifest,
    })
    .from(packageDependencies)
    .innerJoin(packages, eq(packages.id, packageDependencies.dependencyId))
    .where(and(eq(packageDependencies.packageId, packageId), eq(packageDependencies.orgId, orgId)));

  const rows = deps.map((dep) => {
    const parsed = parseScopedName(dep.dependencyId);
    const m = (dep.draftManifest ?? {}) as Record<string, unknown>;
    return {
      type: dep.type,
      registryScope: parsed?.scope ?? null,
      registryName: parsed?.name ?? null,
      version: (m.version as string) ?? null,
    };
  });

  return buildRegistryDepsFromRows(rows);
}

/** Get all files for a flow's referenced items of a type. Returns Map<itemId, files>. */
export async function getFlowItemFiles(
  packageId: string,
  orgId: string,
  cfg: PackageTypeConfig,
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
      const files = await downloadPackageFiles(cfg.storageFolder, orgId, row.dependencyId);
      return [row.dependencyId, files] as const;
    }),
  );

  const result = new Map<string, Record<string, Uint8Array>>();
  for (const [id, files] of entries) {
    if (files) result.set(id, files);
  }
  return result;
}
