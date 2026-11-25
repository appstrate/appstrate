// SPDX-License-Identifier: Apache-2.0

/** Reading a drizzle migration tree: journal, newest snapshot, and the tables it declares. */

import { Glob } from "bun";
import { dirname, join, relative } from "node:path";
import { workspaceModuleRoots } from "./workspace-modules.ts";

/** The subset of `meta/_journal.json` these gates read. */
export interface DrizzleJournal {
  entries: { idx: number; tag: string; when: number }[];
}

/** The subset of `meta/NNNN_snapshot.json` these gates read. */
export interface DrizzleSnapshot {
  tables: Record<
    string,
    {
      schema?: string;
      indexes?: Record<string, unknown>;
      /** Keyed by SQL column name; drizzle writes `notNull` on every entry. */
      columns?: Record<string, { notNull?: boolean }>;
    }
  >;
}

/** Zero-padded to the 4 digits drizzle-kit uses: `40` → `0040_snapshot.json`. */
export function snapshotNameForIdx(idx: number): string {
  return `${String(idx).padStart(4, "0")}_snapshot.json`;
}

/** Snapshot filename of the highest `idx` in the journal — entries need not be sorted. */
export function latestSnapshotName(journal: DrizzleJournal): string {
  let latest: number | null = null;
  for (const entry of journal.entries) {
    if (latest === null || entry.idx > latest) latest = entry.idx;
  }
  if (latest === null)
    throw new Error("Drizzle journal has no entries — cannot resolve a snapshot");
  return snapshotNameForIdx(latest);
}

/** Public-schema table names a snapshot DECLARES; keys are `<schema>.<table>`, `""` for public. */
export function declaredTables(snapshot: DrizzleSnapshot): Set<string> {
  const names = new Set<string>();
  for (const [key, table] of Object.entries(snapshot.tables)) {
    const schema = table.schema ?? "";
    if (schema !== "" && schema !== "public") continue;
    names.add(key.slice(key.indexOf(".") + 1));
  }
  return names;
}

interface ModuleTables {
  id: string;
  packageDir: string;
  snapshot: string;
  tables: Set<string>;
}

/** Every workspace module package (`workspaceModuleRoots`) owning a migration tree, with the
 * tables it declares. The journal glob matches at any depth — module trees nest `meta/` one
 * level deeper than the platform's. */
export async function moduleOwnedTables(repoRoot: string): Promise<ModuleTables[]> {
  const found: ModuleTables[] = [];
  for (const { id, dir } of workspaceModuleRoots(repoRoot)) {
    const packageDir = join(repoRoot, dir);
    for await (const rel of new Glob("**/meta/_journal.json").scan({ cwd: packageDir })) {
      if (rel.includes("node_modules/")) continue;
      const metaDir = join(packageDir, dirname(rel));
      const journal: DrizzleJournal = await Bun.file(join(metaDir, "_journal.json")).json();
      const snapshotName = latestSnapshotName(journal);
      const snapshotPath = join(metaDir, snapshotName);
      const snapshot: DrizzleSnapshot = await Bun.file(snapshotPath).json();
      found.push({
        id,
        packageDir: dir,
        snapshot: relative(repoRoot, snapshotPath).split("\\").join("/"),
        tables: declaredTables(snapshot),
      });
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}
