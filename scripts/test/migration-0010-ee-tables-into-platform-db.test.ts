// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0010` moves billing rows between two live databases, so the only
 * test worth having is the one that runs it against two. Every database here is
 * a throwaway on the test PostgreSQL.
 *
 * Two sources, because a deployment has one of two shapes. The `ee_*` one is
 * the module's current schema, seeded through its own migrator; the `cloud_*`
 * one is production's — migration level `0003`, applied file by file, without
 * `0004`'s billing managers and contact columns and without `0005`'s rename.
 *
 * What the phases pin down: the dry-run writes nothing, `--apply` preserves the
 * values a JavaScript round-trip would damage (microsecond timestamps, `text[]`
 * arrays) and pages past `PAGE` on a composite key, a `cloud_*` source lands in
 * `ee_*` with the columns it never had taking their defaults, a second `--apply`
 * refuses instead of double-counting, and a source the script cannot account for
 * — an unknown table, a column the target does not declare, a level below the
 * one the copy can carry, no journal at all — is refused before the target is
 * touched at all. And the case an operator actually hits: a target the module
 * has already booted against, whose seeded watermark is replaced rather than
 * refused, while a target holding anything else is still refused — with both
 * sides' counts, and no branch telling anyone to discard a database.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describeRequiresPostgres } from "../../apps/api/test/helpers/tier.ts";
import { EE_TABLES } from "../migration/0010-ee-tables-into-platform-db.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SCRIPT = "scripts/migration/0010-ee-tables-into-platform-db.ts";
const MODULE_ROOT = resolve(REPO_ROOT, "packages/module-ee");
const MIGRATIONS_DIR = resolve(MODULE_ROOT, "drizzle/migrations");
const SUFFIX = Math.random().toString(36).slice(2, 10);

/**
 * The module's migrator, reached by a computed specifier — the same shape the
 * script under test uses. This file is Apache-2.0 and the module is not: it
 * runs the module's code, it does not name it in a literal specifier.
 */
async function migrateEeDb(url: string): Promise<void> {
  const db = (await import(resolve(MODULE_ROOT, "src/db.ts"))) as {
    migrateEeDb: (databaseUrl: string) => Promise<void>;
  };
  await db.migrateEeDb(url);
}

const ORG_A = "00000000-0000-4000-a000-00000000aa01";
const ORG_B = "00000000-0000-4000-a000-00000000aa02";
// Microseconds, and an address with a space in it: the two values a `Date` /
// JS-array round trip would quietly rewrite.
const CREATED_AT = "2026-03-04 05:06:07.123456+00";
const BILLING_CC = ["copy@example.com", "second copy@example.com"];
/** One more than the script's page size, so the keyset walk takes a second page. */
const MANAGERS = 501;

/**
 * The module's journal, read where the script reads it. Literals here would turn
 * every new migration into a failure of this file.
 */
const JOURNAL = (
  JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { when: number; tag: string }[];
  }
).entries;
const SHIPPED_MIGRATIONS = JOURNAL.length;
const WHEN = new Map(JOURNAL.map((e) => [e.tag, e.when]));

/** Production's level: the last migration the module applied while it owned a database. */
const PRODUCTION_CHAIN = [
  "0000_init",
  "0001_cursor_billing",
  "0002_numeric_cost",
  "0003_normalize_free_subscription_status",
];

let admin: SQL | undefined;
const created: string[] = [];

let source: SQL;
let target: SQL;
let legacy: SQL;
let legacyTarget: SQL;
let refusalTarget: SQL;
let unmigrated: SQL;
let bootedTarget: SQL;
let bootedDataTarget: SQL;

let sourceUrl: string;
let targetUrl: string;
let legacyUrl: string;
let legacyTargetUrl: string;
let refusalTargetUrl: string;
let unmigratedUrl: string;
let bootedTargetUrl: string;
let bootedDataTargetUrl: string;

function databaseUrl(name: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase(prefix: string): Promise<string> {
  const name = `${prefix}_${SUFFIX}`;
  await admin!.unsafe(`CREATE DATABASE ${name}`);
  created.push(name);
  return databaseUrl(name);
}

function run(env: { source: string; target: string }, args: string[] = []) {
  const proc = Bun.spawnSync({
    cmd: ["bun", SCRIPT, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, EE_SOURCE_DATABASE_URL: env.source, DATABASE_URL: env.target },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode ?? 1, output: proc.stdout.toString() + proc.stderr.toString() };
}

/** Every row of every table, rendered as text so the comparison is exact. */
async function snapshot(db: SQL): Promise<Record<string, unknown[]>> {
  const snap: Record<string, unknown[]> = {};
  for (const table of EE_TABLES) {
    snap[table] = await db.unsafe(`SELECT to_jsonb(t)::text AS row FROM "${table}" t ORDER BY 1`);
  }
  return snap;
}

/**
 * Apply ONE migration file, statement by statement, and record it the way
 * drizzle's default migrator does — `drizzle.__drizzle_migrations`, stamped with
 * the journal's `when`. That table is the one the module wrote for as long as it
 * owned a database outright, and `0010` reads it to grade the source's level.
 * The migrator only ever runs the whole outstanding folder, so building an
 * intermediate schema means replaying files, as the module's own
 * `migrate.test.ts` does.
 */
async function applyMigration(db: SQL, tag: string): Promise<void> {
  const file = readFileSync(resolve(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  for (const chunk of file.split("--> statement-breakpoint")) {
    const statement = chunk.trim();
    if (!statement.split("\n").some((line) => line.trim() && !line.trim().startsWith("--"))) {
      continue;
    }
    await db.unsafe(statement);
  }
  await db.unsafe(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await db.unsafe(
    `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
       id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
  );
  await db.unsafe(
    `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2::bigint)`,
    [new Bun.CryptoHasher("sha256").update(file).digest("hex"), String(WHEN.get(tag)!)],
  );
}

/**
 * Every phase needs two live PostgreSQL databases and a subprocess that can
 * attach to them, so the whole file is gated: tier-0 runs on PGlite and has no
 * DATABASE_URL for `databaseUrl()` to derive a throwaway from.
 */
describeRequiresPostgres("scripts/migration/0010-ee-tables-into-platform-db", () => {
  beforeAll(async () => {
    admin = new SQL(databaseUrl("postgres"));
    sourceUrl = await createDatabase("ee_src");
    targetUrl = await createDatabase("ee_dst");
    legacyUrl = await createDatabase("ee_legacy_src");
    legacyTargetUrl = await createDatabase("ee_legacy_dst");
    refusalTargetUrl = await createDatabase("ee_refuse_dst");
    unmigratedUrl = await createDatabase("ee_old_src");
    bootedTargetUrl = await createDatabase("ee_booted_dst");
    bootedDataTargetUrl = await createDatabase("ee_booted_data_dst");

    await migrateEeDb(sourceUrl);
    source = new SQL(sourceUrl);
    target = new SQL(targetUrl);
    legacy = new SQL(legacyUrl);
    legacyTarget = new SQL(legacyTargetUrl);
    refusalTarget = new SQL(refusalTargetUrl);
    unmigrated = new SQL(unmigratedUrl);

    // Two targets the module has already booted against: `migrateEeDb` ran and
    // `ensureCursorSeeded` INSERTed the singleton watermark. The second also
    // holds a billing account, which is data no copy may walk over.
    await migrateEeDb(bootedTargetUrl);
    await migrateEeDb(bootedDataTargetUrl);
    bootedTarget = new SQL(bootedTargetUrl);
    bootedDataTarget = new SQL(bootedDataTargetUrl);
    for (const db of [bootedTarget, bootedDataTarget]) {
      await db.unsafe(
        `INSERT INTO ee_billing_cursor (id, last_llm_usage_id, floor_id) VALUES (true, 7000, 7000)`,
      );
    }
    await bootedDataTarget.unsafe(
      `INSERT INTO ee_billing_accounts (org_id, plan_id, credits_used, credit_quota)
       VALUES ($1, 'pro', 1, 20000)`,
      [ORG_B],
    );

    await source.unsafe(
      `INSERT INTO ee_billing_accounts (org_id, plan_id, credits_used, credit_quota, billing_cc, created_at, updated_at)
       VALUES ($1, 'pro', 42, 20000, $2::text[], $3::timestamptz, $3::timestamptz),
              ($4, 'free', 0, 0, '{}', $3::timestamptz, $3::timestamptz)`,
      [ORG_A, `{"${BILLING_CC[0]}","${BILLING_CC[1]}"}`, CREATED_AT, ORG_B],
    );
    await source.unsafe(
      `INSERT INTO ee_usage_records (org_id, context_type, context_id, cost_credits, cost_usd, created_at)
       VALUES ($1, 'run', 'run-1', 12, 0.012345678901, $2::timestamptz),
              ($1, 'chat', 'chat-1', 3, 0.000000000001, $2::timestamptz)`,
      [ORG_A, CREATED_AT],
    );
    await source.unsafe(
      `INSERT INTO ee_stripe_events (event_id, event_type, status, claimed_at, processed_at)
       VALUES ('evt_1', 'invoice.paid', 'done', $1::timestamptz, $1::timestamptz),
              ('evt_2', 'customer.subscription.updated', 'processing', $1::timestamptz, NULL)`,
      [CREATED_AT],
    );
    await source.unsafe(
      `INSERT INTO ee_billed_llm_usage (llm_usage_id, billed_at)
       VALUES (1, $1::timestamptz), (2, $1::timestamptz)`,
      [CREATED_AT],
    );
    await source.unsafe(
      `INSERT INTO ee_free_tier_claims (email, claimed_at) VALUES ('claimed@example.com', $1::timestamptz)`,
      [CREATED_AT],
    );
    await source.unsafe(
      `INSERT INTO ee_billing_cursor (id, last_llm_usage_id, updated_at) VALUES (true, 99, $1::timestamptz)`,
      [CREATED_AT],
    );
    // A composite primary key, over more rows than one page holds.
    await source.unsafe(
      `INSERT INTO ee_billing_managers (org_id, user_id, added_by, created_at)
       SELECT gen_random_uuid(), 'user-' || g, 'user-owner', $1::timestamptz
         FROM generate_series(1, ${MANAGERS}) g`,
      [CREATED_AT],
    );

    // Production's shape: the chain stops at 0003, so the tables are still
    // `cloud_*`, there is no managers table and no billing contact columns.
    for (const tag of PRODUCTION_CHAIN) {
      await applyMigration(legacy, tag);
    }
    // One migration short of production: 0003's normalization has not run, so
    // its rows are the ones the copy could never repair.
    for (const tag of PRODUCTION_CHAIN.slice(0, -1)) {
      await applyMigration(unmigrated, tag);
    }
    await unmigrated.unsafe(
      `INSERT INTO cloud_billing_accounts (org_id, plan_id, credits_used, credit_quota, subscription_status, created_at, updated_at)
       VALUES ($1, 'free', 0, 0, 'canceled', $2::timestamptz, $2::timestamptz)`,
      [ORG_A, CREATED_AT],
    );
    await legacy.unsafe(
      `INSERT INTO cloud_billing_accounts (org_id, plan_id, credits_used, credit_quota, created_at, updated_at)
       VALUES ($1, 'pro', 42, 20000, $2::timestamptz, $2::timestamptz)`,
      [ORG_A, CREATED_AT],
    );
    await legacy.unsafe(
      `INSERT INTO cloud_usage_records (org_id, context_type, context_id, cost_credits, cost_usd, created_at)
       VALUES ($1, 'run', 'run-legacy', 7, 0.007000000001, $2::timestamptz)`,
      [ORG_A, CREATED_AT],
    );
    await legacy.unsafe(
      `INSERT INTO cloud_billing_cursor (id, last_llm_usage_id, updated_at) VALUES (true, 41, $1::timestamptz)`,
      [CREATED_AT],
    );
  }, 120_000);

  afterAll(async () => {
    await source?.close();
    await target?.close();
    await legacy?.close();
    await legacyTarget?.close();
    await refusalTarget?.close();
    await unmigrated?.close();
    await bootedTarget?.close();
    await bootedDataTarget?.close();
    if (!admin) return;
    for (const name of created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    await admin.close();
  });

  describe("0010 — ee tables into the platform database", () => {
    it("names the missing variable instead of half-running", () => {
      const proc = Bun.spawnSync({
        cmd: ["bun", SCRIPT],
        cwd: REPO_ROOT,
        env: { ...process.env, EE_SOURCE_DATABASE_URL: "", DATABASE_URL: targetUrl },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(2);
      expect(proc.stdout.toString()).toContain("EE_SOURCE_DATABASE_URL is required");
    });

    it("dry-runs: counts both sides and writes nothing", async () => {
      const { code, output } = run({ source: sourceUrl, target: targetUrl });
      expect(code).toBe(0);
      expect(output).toContain("source prefix: ee_");
      expect(output).toContain(
        `would apply the module's migrations — ${SHIPPED_MIGRATIONS} pending on the target`,
      );
      expect(output).toMatch(/ee_billing_accounts\s+\|\s+2\s+\|\s+absent/);
      expect(output).toMatch(
        new RegExp(`ee_billing_managers\\s+\\|\\s+${MANAGERS}\\s+\\|\\s+absent`),
      );
      expect(output).toContain("dry-run — nothing was written");

      // Not "no rows" but "no tables": a dry-run does not migrate either.
      const [{ present }] = await target.unsafe(
        `SELECT to_regclass('ee_billing_accounts') IS NOT NULL AS present`,
      );
      expect(present).toBe(false);
    }, 60_000);

    it("copies every row, preserving microseconds and arrays and paging past the page size", async () => {
      const { code, output } = run({ source: sourceUrl, target: targetUrl }, ["--apply"]);
      expect(code).toBe(0);
      expect(output).toContain("copied — every table matches");
      expect(output).toMatch(/ee_billing_accounts\s+\|\s+2\s+\|\s+2\s+\|\s+yes/);
      expect(output).toMatch(
        new RegExp(`ee_billing_managers\\s+\\|\\s+${MANAGERS}\\s+\\|\\s+${MANAGERS}\\s+\\|\\s+yes`),
      );

      expect(await snapshot(target)).toEqual(await snapshot(source));

      const [account] = await target.unsafe(
        `SELECT to_char(created_at, 'US') AS us, billing_cc FROM ee_billing_accounts WHERE org_id = $1`,
        [ORG_A],
      );
      expect(account.us).toBe("123456");
      expect(account.billing_cc).toEqual(BILLING_CC);

      const [{ applied }] = await target.unsafe(
        `SELECT count(*)::int AS applied FROM drizzle.ee_migrations`,
      );
      expect(applied).toBe(SHIPPED_MIGRATIONS);
    }, 60_000);

    it("refuses a second --apply and leaves the target as it was", async () => {
      const before = await snapshot(target);
      const { code, output } = run({ source: sourceUrl, target: targetUrl }, ["--apply"]);
      expect(code).toBe(1);
      expect(output).toContain("refusing: the target already holds billing rows");
      expect(output).toContain("ee_billing_accounts");
      expect(await snapshot(target)).toEqual(before);
    }, 60_000);
  });

  /**
   * The module's `init()` seeds the singleton billing cursor, so a restart or a
   * health probe before the maintenance window puts one row on the target. That
   * is the module's own artefact, not a copy, and the refusal that used to fire
   * on it told the operator the move had already run.
   */
  describe("0010 — a target the module has already booted against", () => {
    it("replaces the boot-seeded watermark with the source's instead of refusing", async () => {
      const { code, output } = run({ source: legacyUrl, target: bootedTargetUrl }, ["--apply"]);
      expect(code).toBe(0);
      expect(output).toContain("a watermark a boot seeded — replaced by the source's");
      expect(output).toContain("copied — every table matches");

      const rows = await bootedTarget.unsafe(
        `SELECT last_llm_usage_id, floor_id FROM ee_billing_cursor`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].last_llm_usage_id).toBe(41);
      // The source predates 0006, so its cursor has no floor of its own: the
      // column takes the declared default rather than the boot's 7000.
      expect(rows[0].floor_id).toBe(0);

      const [{ accounts }] = await bootedTarget.unsafe(
        `SELECT count(*)::int AS accounts FROM ee_billing_accounts`,
      );
      expect(accounts).toBe(1);
    }, 60_000);

    it("still refuses when a table other than the cursor holds rows, and says so with counts", async () => {
      const before = await snapshot(bootedDataTarget);
      const { code, output } = run({ source: legacyUrl, target: bootedDataTargetUrl }, ["--apply"]);
      expect(code).toBe(1);
      expect(output).toContain(
        "refusing: the target already holds billing rows (ee_billing_accounts)",
      );
      // The counts are the evidence the refusal hands over; no branch of it may
      // read as an instruction to discard either side.
      expect(output).toMatch(/ee_billing_accounts\s+\|\s+1\s+\|\s+1\s+\|/);
      expect(output).toMatch(/ee_usage_records\s+\|\s+1\s+\|\s+0\s+\|/);
      expect(output).not.toContain("nothing is left to do");
      expect(output).not.toContain("empty the target");
      expect(await snapshot(bootedDataTarget)).toEqual(before);
    }, 60_000);
  });

  describe("0010 — a source below the level the copy can carry", () => {
    it("refuses a source that never ran 0003 rather than copying rows nothing can repair", async () => {
      const { code, output } = run({ source: unmigratedUrl, target: refusalTargetUrl }, [
        "--apply",
      ]);
      expect(code).toBe(1);
      expect(output).toContain("refusing: the source is at 0002_numeric_cost");
      expect(output).toContain("needs 0003_normalize_free_subscription_status or later");

      const [{ present }] = await refusalTarget.unsafe(
        `SELECT to_regclass('ee_billing_accounts') IS NOT NULL AS present`,
      );
      expect(present).toBe(false);
    }, 60_000);

    it("refuses a source with no journal of the module's at all", async () => {
      await unmigrated.unsafe(`ALTER TABLE drizzle.__drizzle_migrations RENAME TO parked`);
      try {
        const { code, output } = run({ source: unmigratedUrl, target: refusalTargetUrl }, [
          "--apply",
        ]);
        expect(code).toBe(1);
        expect(output).toContain("refusing: the source records no migration of the module's");
      } finally {
        await unmigrated.unsafe(`ALTER TABLE drizzle.parked RENAME TO __drizzle_migrations`);
      }
    }, 60_000);
  });

  describe("0010 — a cloud_ source at migration level 0003", () => {
    it("copies it into ee_*, defaulting the columns 0004 would have added", async () => {
      const { code, output } = run({ source: legacyUrl, target: legacyTargetUrl }, ["--apply"]);
      expect(code).toBe(0);
      expect(output).toContain("source prefix: cloud_");
      // `0004`'s two columns are absent from this source and take their declared
      // default. Matched inside the accounts line rather than as a bare
      // substring: a later migration adding a column defaults them beside it.
      expect(output).toMatch(
        /ee_billing_accounts ← cloud_billing_accounts \([^)]*\bbilling_email\b[^)]*\bbilling_cc\b[^)]*← default\)/,
      );
      expect(output).toContain("ee_billing_managers ← absent from the source");
      expect(output).toContain("copied — every table matches");

      const [account] = await legacyTarget.unsafe(
        `SELECT plan_id, billing_email, billing_cc, to_char(created_at, 'US') AS us
           FROM ee_billing_accounts WHERE org_id = $1`,
        [ORG_A],
      );
      expect(account.plan_id).toBe("pro");
      expect(account.billing_email).toBeNull();
      expect(account.billing_cc).toEqual([]);
      expect(account.us).toBe("123456");

      const [record] = await legacyTarget.unsafe(
        `SELECT context_id, cost_usd FROM ee_usage_records`,
      );
      expect(record.context_id).toBe("run-legacy");
      expect(record.cost_usd).toBe("0.007000000001");

      const [{ managers }] = await legacyTarget.unsafe(
        `SELECT count(*)::int AS managers FROM ee_billing_managers`,
      );
      expect(managers).toBe(0);

      const [cursor] = await legacyTarget.unsafe(`SELECT last_llm_usage_id FROM ee_billing_cursor`);
      expect(cursor.last_llm_usage_id).toBe(41);
    }, 60_000);
  });

  describe("0010 — a source it cannot account for is refused before the target is touched", () => {
    /** The target must still have no `ee_*` tables: nothing ran, migrations included. */
    async function targetUntouched(): Promise<boolean> {
      const [{ present }] = await refusalTarget.unsafe(
        `SELECT to_regclass('ee_billing_accounts') IS NOT NULL AS present`,
      );
      return present === false;
    }

    it("refuses an ee_/cloud_ table it does not move rather than leaving it behind", async () => {
      await legacy.unsafe(`CREATE TABLE cloud_extra (id integer PRIMARY KEY)`);
      try {
        const { code, output } = run({ source: legacyUrl, target: refusalTargetUrl }, ["--apply"]);
        expect(code).toBe(1);
        expect(output).toContain("does not move: cloud_extra");
        expect(await targetUntouched()).toBe(true);
      } finally {
        await legacy.unsafe(`DROP TABLE cloud_extra`);
      }
    }, 60_000);

    it("refuses a source column the target does not declare rather than dropping it", async () => {
      await legacy.unsafe(`ALTER TABLE cloud_billing_accounts ADD COLUMN legacy_note text`);
      try {
        const { code, output } = run({ source: legacyUrl, target: refusalTargetUrl }, ["--apply"]);
        expect(code).toBe(1);
        expect(output).toContain(
          "refusing: cloud_billing_accounts has column(s) ee_billing_accounts does not declare: legacy_note",
        );
        expect(await targetUntouched()).toBe(true);
      } finally {
        await legacy.unsafe(`ALTER TABLE cloud_billing_accounts DROP COLUMN legacy_note`);
      }
    }, 60_000);
  });
});
