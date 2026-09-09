// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a drizzle migration tree — the journal, the snapshot it points at,
 * and the tables that snapshot declares.
 *
 * Two gates ask the same question of the same files and must not answer it
 * differently. `check-index-drift.ts` needs the PLATFORM snapshot's tables to
 * know which indexes are its business; `verify-module-sql-boundary.ts` needs a
 * MODULE snapshot's tables to know which names that module may write in SQL.
 * Since `@appstrate/module-ee` migrates its own tables into the platform
 * database, the two populations sit in one `public` schema and are told apart
 * only by which snapshot declares them — so "which tables does this tree own"
 * has to have exactly one implementation.
 */

import { Glob } from "bun";
import { dirname, join, relative } from "node:path";

/** The subset of `meta/_journal.json` these gates read. */
export interface DrizzleJournal {
  entries: { idx: number; tag: string; when: number }[];
}

/** The subset of `meta/NNNN_snapshot.json` these gates read. */
export interface DrizzleSnapshot {
  tables: Record<string, { schema?: string; indexes?: Record<string, unknown> }>;
}

/** Zero-padded to the 4 digits drizzle-kit uses: `40` → `0040_snapshot.json`. */
export function snapshotNameForIdx(idx: number): string {
  return `${String(idx).padStart(4, "0")}_snapshot.json`;
}

/**
 * Snapshot filename of the highest `idx` in the journal — the newest schema on
 * disk.
 *
 * Journal entries are appended by `drizzle-kit generate` and are normally
 * contiguous and sorted, but neither is relied upon: only the maximum `idx`
 * matters.
 */
export function latestSnapshotName(journal: DrizzleJournal): string {
  let latest: number | null = null;
  for (const entry of journal.entries) {
    if (latest === null || entry.idx > latest) latest = entry.idx;
  }
  if (latest === null)
    throw new Error("Drizzle journal has no entries — cannot resolve a snapshot");
  return snapshotNameForIdx(latest);
}

/**
 * Table names DECLARED by a snapshot, in the public schema.
 *
 * Keys are `<schema>.<table>`; drizzle writes `""` for the public schema and
 * the schema name otherwise. The filter mirrors `pg_indexes`' `schemaname =
 * 'public'` on the actual side of the index diff, and on the SQL side it keeps
 * a `pgSchema(...)` table from being read as a bare identifier.
 */
export function declaredTables(snapshot: DrizzleSnapshot): Set<string> {
  const names = new Set<string>();
  for (const [key, table] of Object.entries(snapshot.tables)) {
    const schema = table.schema ?? "";
    if (schema !== "" && schema !== "public") continue;
    names.add(key.slice(key.indexOf(".") + 1));
  }
  return names;
}

/** One workspace module that carries a drizzle migration tree of its own. */
interface ModuleTables {
  /** Module id with `module-` stripped — `ee`. */
  id: string;
  /** Repo-relative package directory — `packages/module-ee`. */
  packageDir: string;
  /** Repo-relative snapshot the table list was read from. */
  snapshot: string;
  /** Public-schema table names that snapshot declares. */
  tables: Set<string>;
}

/**
 * Every `packages/module-*` that owns a migration tree, with the tables it
 * declares — discovered, never listed.
 *
 * The discovery signal is the journal file itself (`meta/_journal.json`), which
 * is also the only thing that makes a module's tables knowable: a module
 * without one owns no tables, and a hardcoded roster of "modules with a
 * database" is the shape that silently stops covering the next one. Today
 * exactly one module qualifies.
 *
 * The glob matches `meta/_journal.json` at ANY depth under the package rather
 * than at one fixed path: the platform's own tree puts `meta/` directly under
 * `drizzle/` while a module's drizzle-kit config puts it under
 * `drizzle/migrations/`, and anchoring on either layout would make a correct
 * relocation read as "this module owns nothing".
 */
export async function moduleOwnedTables(repoRoot: string): Promise<ModuleTables[]> {
  const packagesDir = join(repoRoot, "packages");
  const found: ModuleTables[] = [];
  const glob = new Glob("module-*/**/meta/_journal.json");
  for await (const rel of glob.scan({ cwd: packagesDir })) {
    if (rel.includes("node_modules/")) continue;
    const metaDir = join(packagesDir, dirname(rel));
    const journal: DrizzleJournal = await Bun.file(join(metaDir, "_journal.json")).json();
    const snapshotName = latestSnapshotName(journal);
    const snapshotPath = join(metaDir, snapshotName);
    const snapshot: DrizzleSnapshot = await Bun.file(snapshotPath).json();
    const dir = rel.split("/")[0]!;
    found.push({
      id: dir.replace(/^module-/, ""),
      packageDir: `packages/${dir}`,
      snapshot: relative(repoRoot, snapshotPath).split("\\").join("/"),
      tables: declaredTables(snapshot),
    });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}
