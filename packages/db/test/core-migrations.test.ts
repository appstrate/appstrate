// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import {
  applyCoreMigrations,
  assertCoreMigrationsApplied,
  listPendingCoreMigrations,
} from "../src/core-migrations.ts";

const describeRequiresPostgres = describe.skipIf(!process.env.DATABASE_URL);

/** Same server as DATABASE_URL, another database name. */
function urlFor(dbName: string): string {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function journalTags(): Promise<string[]> {
  const path = new URL("../drizzle/meta/_journal.json", import.meta.url);
  const journal = (await Bun.file(path).json()) as { entries: { tag: string }[] };
  return journal.entries.map((e) => e.tag);
}

describeRequiresPostgres("core migrations: apply / pending / assert (real PostgreSQL)", () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const names = [`core_mig_a_${suffix}`, `core_mig_b_${suffix}`];
  let admin: ReturnType<typeof postgres>;

  beforeAll(async () => {
    admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    for (const n of names) await admin.unsafe(`CREATE DATABASE "${n}"`);
  });

  afterAll(async () => {
    for (const n of names) await admin.unsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
    await admin.end();
  });

  it("reports every tag pending on a fresh database, none after apply, and assert resolves", async () => {
    const url = urlFor(names[0]!);
    const tags = await journalTags();
    expect(await listPendingCoreMigrations(url)).toEqual(tags);
    await expect(assertCoreMigrationsApplied(url)).rejects.toThrow(
      /core migration\(s\) not applied/,
    );

    await applyCoreMigrations(url);

    expect(await listPendingCoreMigrations(url)).toEqual([]);
    await assertCoreMigrationsApplied(url);
  });

  it("reports the last tag pending once its journal row is removed, and assert names it", async () => {
    const url = urlFor(names[0]!);
    const last = (await journalTags()).at(-1)!;
    const sql = postgres(url, { max: 1 });
    try {
      await sql`DELETE FROM drizzle."__drizzle_migrations"
                WHERE id = (SELECT max(id) FROM drizzle."__drizzle_migrations")`;
    } finally {
      await sql.end();
    }

    expect(await listPendingCoreMigrations(url)).toEqual([last]);
    await expect(assertCoreMigrationsApplied(url)).rejects.toThrow(
      new RegExp(`1 core migration\\(s\\) not applied to this database: ${last}`),
    );
  });

  it("two concurrent applyCoreMigrations on a fresh database both resolve", async () => {
    const url = urlFor(names[1]!);
    await Promise.all([applyCoreMigrations(url), applyCoreMigrations(url)]);
    expect(await listPendingCoreMigrations(url)).toEqual([]);
  });
});
