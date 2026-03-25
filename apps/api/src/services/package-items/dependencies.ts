import { eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import { parseScopedName } from "@appstrate/core/naming";
import { buildDependenciesFromRows, type Dependencies } from "@appstrate/core/dependencies";
import { type PackageTypeConfig } from "./config.ts";
import { downloadPackageFiles } from "./storage.ts";
import { asRecord } from "../../lib/safe-json.ts";
import { extractDepsFromManifest } from "../../lib/manifest-utils.ts";
import type { Manifest } from "@appstrate/core/validation";

// ─────────────────────────────────────────────
// Dependency resolution from manifest (single source of truth)
// ─────────────────────────────────────────────

/** Build dependencies object from a package's manifest. */
export async function buildDependencies(
  packageId: string,
  _orgId: string,
): Promise<Dependencies | null> {
  const [pkg] = await db
    .select({ draftManifest: packages.draftManifest })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!pkg) return null;

  const manifest = asRecord(pkg.draftManifest) as Partial<Manifest>;
  const { skillIds, toolIds, providerIds } = extractDepsFromManifest(manifest);
  const allDepIds = [...skillIds, ...toolIds, ...providerIds];
  if (allDepIds.length === 0) return null;

  const depRows = await db
    .select({ id: packages.id, type: packages.type, draftManifest: packages.draftManifest })
    .from(packages)
    .where(inArray(packages.id, allDepIds));

  const rows = depRows.map((dep) => {
    const parsed = parseScopedName(dep.id);
    const m = asRecord(dep.draftManifest);
    return {
      type: dep.type,
      registryScope: parsed?.scope ?? null,
      registryName: parsed?.name ?? null,
      version: (m.version as string) ?? null,
    };
  });

  return buildDependenciesFromRows(rows);
}

/** Get all files for a package's referenced items of a type. Returns Map<itemId, files>. */
export async function getFlowItemFiles(
  packageId: string,
  orgId: string,
  cfg: PackageTypeConfig,
): Promise<Map<string, Record<string, Uint8Array>>> {
  const [pkg] = await db
    .select({ draftManifest: packages.draftManifest })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!pkg) return new Map();

  const { skillIds, toolIds, providerIds } = extractDepsFromManifest(
    asRecord(pkg.draftManifest) as Partial<Manifest>,
  );

  const typeToIds: Record<string, string[]> = {
    skill: skillIds,
    tool: toolIds,
    provider: providerIds,
  };
  const depIds = typeToIds[cfg.type] ?? [];

  const entries = await Promise.all(
    depIds.map(async (depId) => {
      const files = await downloadPackageFiles(cfg.storageFolder, orgId, depId);
      return [depId, files] as const;
    }),
  );

  const result = new Map<string, Record<string, Uint8Array>>();
  for (const [id, files] of entries) {
    if (files) result.set(id, files);
  }
  return result;
}
