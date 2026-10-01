// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyCorePGliteMigrations } from "../../src/lib/pglite-migrate.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages/db/drizzle");
const DUMP_CACHE_DIR = join(REPO_ROOT, "node_modules/.cache/appstrate-test/pglite");
/** A dump nobody has loaded for this long belongs to a journal that moved on. */
const DUMP_UNUSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface Journal {
  entries: { tag: string }[];
}

async function readJournal(): Promise<Journal> {
  return (await Bun.file(`${MIGRATIONS_DIR}/meta/_journal.json`).json()) as Journal;
}

/**
 * Replay the platform journal onto a private PGlite the way the Tier 0 runner
 * does (`apps/api/src/lib/pglite-migrate.ts`): whole file, breakpoints stripped,
 * one transaction each. With `lastTag` it stops after that entry, and throws if
 * there is none, so a renamed migration fails the caller instead of silently
 * shortening the replay.
 */
async function replayJournal(db: PGlite, lastTag?: string): Promise<void> {
  const journal = await readJournal();
  for (const { tag } of journal.entries) {
    const source = await Bun.file(`${MIGRATIONS_DIR}/${tag}.sql`).text();
    await db.transaction(async (tx) => {
      await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
    });
    if (tag === lastTag) return;
  }
  if (lastTag !== undefined) throw new Error(`journal has no entry tagged ${lastTag}`);
}

export interface JournalDumpOptions {
  /** Stop after this journal tag. Default: the whole journal. */
  through?: string;
  /** Apply with `applyCorePGliteMigrations` (ledger included), as boot does. Whole journal only. */
  ledger?: boolean;
}

/**
 * A `dumpDataDir` tarball of a fresh cluster with the journal applied, cached
 * on disk: a replay costs ~6 s, loading the dump well under one. The key hashes
 * everything the dump is made from (PGlite build, builder code, options, every
 * migration applied), so a stale dump is never served; concurrent builders
 * `rename` a private file into place.
 */
async function journalDump(options: JournalDumpOptions = {}): Promise<string> {
  const { through, ledger = false } = options;
  if (ledger && through !== undefined) {
    throw new Error("journalDump: `ledger` applies the whole journal; it cannot stop at a tag.");
  }
  const journal = await readJournal();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(Bun.resolveSync("@electric-sql/pglite", import.meta.dir));
  for (const builder of [import.meta.path, join(REPO_ROOT, "apps/api/src/lib/pglite-migrate.ts")]) {
    hasher.update(await Bun.file(builder).text());
  }
  hasher.update(JSON.stringify({ ledger }));
  let reached = through === undefined;
  for (const { tag } of journal.entries) {
    hasher.update(tag);
    hasher.update(await Bun.file(`${MIGRATIONS_DIR}/${tag}.sql`).text());
    if (tag === through) {
      reached = true;
      break;
    }
  }
  if (!reached) throw new Error(`journal has no entry tagged ${through}`);

  const path = join(DUMP_CACHE_DIR, `${hasher.digest("hex")}.tar`);
  const now = new Date();
  if (await Bun.file(path).exists()) {
    try {
      utimesSync(path, now, now);
      return path;
    } catch {
      // Pruned by a concurrent run between the two calls — rebuild it.
    }
  }

  mkdirSync(DUMP_CACHE_DIR, { recursive: true });
  const pg = new PGlite();
  try {
    if (ledger) await applyCorePGliteMigrations(MIGRATIONS_DIR, pg);
    else await replayJournal(pg, through);
    const building = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await Bun.write(building, await pg.dumpDataDir("none"));
    renameSync(building, path);
  } finally {
    await pg.close();
  }
  pruneUnusedDumps(now.getTime());
  return path;
}

function pruneUnusedDumps(now: number): void {
  for (const name of readdirSync(DUMP_CACHE_DIR)) {
    const file = join(DUMP_CACHE_DIR, name);
    try {
      if (now - statSync(file).mtimeMs > DUMP_UNUSED_TTL_MS) rmSync(file, { force: true });
    } catch {
      // A concurrent pruner got there first.
    }
  }
}

/** A fresh in-memory PGlite holding the journal as `journalDump(options)` describes it. */
export async function journalPGlite(options: JournalDumpOptions = {}): Promise<PGlite> {
  const pg = new PGlite({ loadDataDir: Bun.file(await journalDump(options)) });
  await pg.waitReady;
  return pg;
}

/** Fill an empty PGlite data directory with the journal applied as boot applies it. */
export async function seedMigratedDataDir(dataDir: string): Promise<void> {
  const pg = new PGlite(dataDir, { loadDataDir: Bun.file(await journalDump({ ledger: true })) });
  await pg.waitReady;
  await pg.close();
}
