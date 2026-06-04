// SPDX-License-Identifier: Apache-2.0

import { eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import { parseScopedName } from "@appstrate/core/naming";
import type { Dependencies } from "@appstrate/core/dependencies";
import { type PackageTypeConfig } from "./config.ts";
import { downloadPackageFiles } from "./storage.ts";
import { asRecord } from "@appstrate/core/safe-json";
import { extractSkillIdsFromManifest, parseDraftManifest } from "../../lib/manifest-utils.ts";

// ─────────────────────────────────────────────
// Dependency resolution from manifest (single source of truth)
// ─────────────────────────────────────────────

/**
 * Collect all transitive skill dependency IDs via BFS. Handles cycles via a
 * visited set; batches DB reads per iteration. The dependency graph is
 * skill-only (integrations resolve through a separate path), so this returns
 * a flat list of skill package IDs.
 */
export async function collectAllSkillDepIds(rootPackageId: string): Promise<string[]> {
  const skills = new Set<string>();
  const visited = new Set<string>();

  // Seed: read root manifest
  const [rootPkg] = await db
    .select({ draftManifest: packages.draftManifest })
    .from(packages)
    .where(eq(packages.id, rootPackageId))
    .limit(1);
  if (!rootPkg) return [];

  for (const id of extractSkillIdsFromManifest(parseDraftManifest(rootPkg.draftManifest))) {
    skills.add(id);
  }

  // BFS: process unvisited deps in batches
  let frontier = [...skills];
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
      for (const id of extractSkillIdsFromManifest(parseDraftManifest(row.draftManifest))) {
        if (!skills.has(id)) {
          skills.add(id);
          nextFrontier.push(id);
        }
      }
    }
    frontier = nextFrontier;
  }

  return [...skills];
}

/** Build dependencies object from a package's manifest (transitive). */
export async function buildDependencies(packageId: string): Promise<Dependencies | null> {
  const allDepIds = await collectAllSkillDepIds(packageId);
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

  for (const row of rows) {
    if (!row.registryScope || !row.registryName) continue;
    if (!row.version) continue;
    const scopedName = `@${row.registryScope}/${row.registryName}`;
    if (row.type === "skill") skills[scopedName] = row.version;
  }

  if (Object.keys(skills).length === 0) return null;

  const result: Dependencies = { skills };
  return result;
}

/** Get all files for a package's transitive skill deps. Returns Map<itemId, files>. */
export async function getPackageDepFiles(
  packageId: string,
  orgId: string,
  cfg: PackageTypeConfig,
): Promise<Map<string, Record<string, Uint8Array>>> {
  // The transitive graph is skill-only — only skill packages carry dep files.
  const depIds = cfg.type === "skill" ? await collectAllSkillDepIds(packageId) : [];

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
