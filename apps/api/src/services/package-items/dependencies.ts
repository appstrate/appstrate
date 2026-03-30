import { eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import { parseScopedName } from "@appstrate/core/naming";
import type { Dependencies } from "@appstrate/core/dependencies";
import { type PackageTypeConfig } from "./config.ts";
import { downloadPackageFiles } from "./storage.ts";
import { asRecord } from "../../lib/safe-json.ts";
import { extractDepsFromManifest } from "../../lib/manifest-utils.ts";
import type { Manifest } from "@appstrate/core/validation";

// ─────────────────────────────────────────────
// Dependency resolution from manifest (single source of truth)
// ─────────────────────────────────────────────

/**
 * Collect all transitive dependency IDs via BFS, grouped by type.
 * Handles cycles via a visited set. Batches DB reads per iteration.
 */
export async function collectAllDepIds(
  rootPackageId: string,
): Promise<{ skillIds: string[]; toolIds: string[]; providerIds: string[] }> {
  const skills = new Set<string>();
  const tools = new Set<string>();
  const providers = new Set<string>();
  const visited = new Set<string>();

  // Seed: read root manifest
  const [rootPkg] = await db
    .select({ draftManifest: packages.draftManifest })
    .from(packages)
    .where(eq(packages.id, rootPackageId))
    .limit(1);
  if (!rootPkg) return { skillIds: [], toolIds: [], providerIds: [] };

  const rootDeps = extractDepsFromManifest(asRecord(rootPkg.draftManifest) as Partial<Manifest>);
  for (const id of rootDeps.skillIds) skills.add(id);
  for (const id of rootDeps.toolIds) tools.add(id);
  for (const id of rootDeps.providerIds) providers.add(id);

  // BFS: process unvisited deps in batches
  let frontier = [...skills, ...tools, ...providers];
  visited.add(rootPackageId);

  while (frontier.length > 0) {
    const toFetch = frontier.filter((id) => !visited.has(id));
    if (toFetch.length === 0) break;

    for (const id of toFetch) visited.add(id);

    const rows = await db
      .select({ id: packages.id, draftManifest: packages.draftManifest })
      .from(packages)
      .where(inArray(packages.id, toFetch));

    const nextFrontier: string[] = [];
    for (const row of rows) {
      const deps = extractDepsFromManifest(asRecord(row.draftManifest) as Partial<Manifest>);
      for (const id of deps.skillIds) {
        if (!skills.has(id)) {
          skills.add(id);
          nextFrontier.push(id);
        }
      }
      for (const id of deps.toolIds) {
        if (!tools.has(id)) {
          tools.add(id);
          nextFrontier.push(id);
        }
      }
      for (const id of deps.providerIds) {
        if (!providers.has(id)) {
          providers.add(id);
          nextFrontier.push(id);
        }
      }
    }
    frontier = nextFrontier;
  }

  return {
    skillIds: [...skills],
    toolIds: [...tools],
    providerIds: [...providers],
  };
}

/** Build dependencies object from a package's manifest (transitive). */
export async function buildDependencies(packageId: string): Promise<Dependencies | null> {
  const allDeps = await collectAllDepIds(packageId);
  const allDepIds = [...allDeps.skillIds, ...allDeps.toolIds, ...allDeps.providerIds];
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

  const skills: Record<string, string> = {};
  const tools: Record<string, string> = {};
  const providers: Record<string, string> = {};

  for (const row of rows) {
    if (!row.registryScope || !row.registryName) continue;
    const scopedName = `@${row.registryScope}/${row.registryName}`;
    const version = row.version || "*";
    if (row.type === "skill") skills[scopedName] = version;
    else if (row.type === "tool") tools[scopedName] = version;
    else if (row.type === "provider") providers[scopedName] = version;
  }

  const hasSkills = Object.keys(skills).length > 0;
  const hasTools = Object.keys(tools).length > 0;
  const hasProviders = Object.keys(providers).length > 0;
  if (!hasSkills && !hasTools && !hasProviders) return null;

  const result: Dependencies = {};
  if (hasSkills) result.skills = skills;
  if (hasTools) result.tools = tools;
  if (hasProviders) result.providers = providers;
  return result;
}

/** Get all files for a package's transitive deps of a type. Returns Map<itemId, files>. */
export async function getPackageDepFiles(
  packageId: string,
  orgId: string,
  cfg: PackageTypeConfig,
): Promise<Map<string, Record<string, Uint8Array>>> {
  const allDeps = await collectAllDepIds(packageId);
  const typeToIds: Record<string, string[]> = {
    skill: allDeps.skillIds,
    tool: allDeps.toolIds,
    provider: allDeps.providerIds,
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
