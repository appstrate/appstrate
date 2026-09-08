import { describe, expect, it, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { migrateCloudDb, getCloudDb } from "../../../src/db.ts";
import { getCloudEnv } from "../../../src/env.ts";

const CLOUD_TABLES = [
  "cloud_usage_records",
  "cloud_billed_llm_usage",
  "cloud_billing_cursor",
  "cloud_stripe_events",
  "cloud_free_tier_claims",
  "cloud_billing_managers",
  "cloud_billing_accounts",
];

// Every cloud table across the migration chain, INCLUDING the legacy
// cloud_pending_bills that 0001 drops — the upgrade tests reset to a true
// pre-0000 blank slate.
const ALL_CLOUD_TABLES = [...CLOUD_TABLES, "cloud_pending_bills"];

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../../drizzle/migrations");

/**
 * Split a migration file into individual statements on drizzle's
 * `--> statement-breakpoint` delimiter (dropping comment-only chunks), so the
 * upgrade tests can apply ONE migration at a time — the migrator only ever
 * applies the whole outstanding chain. Executing statement-by-statement also
 * lets a guard's `RAISE EXCEPTION` (0001's non-empty cloud_pending_bills check)
 * surface as a rejected promise while the statements before it stay committed,
 * exactly as a real partial-failure apply would leave the DB.
 */
function migrationStatements(tag: string): string[] {
  return readFileSync(resolve(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((chunk) =>
      chunk.split("\n").some((line) => line.trim() && !line.trim().startsWith("--")),
    );
}

async function applyMigration(db: ReturnType<typeof getCloudDb>, tag: string): Promise<void> {
  for (const statement of migrationStatements(tag)) {
    await db.execute(sql.raw(statement));
  }
}

async function resetToBlankSlate(db: ReturnType<typeof getCloudDb>): Promise<void> {
  await db.execute(sql.raw(`DROP TABLE IF EXISTS ${ALL_CLOUD_TABLES.join(", ")} CASCADE`));
  await db.execute(sql.raw("DROP SCHEMA IF EXISTS drizzle CASCADE"));
}

describe("migrateCloudDb", () => {
  it("serializes two concurrent migrations on a FRESH schema without crashing", async () => {
    const db = getCloudDb();
    const url = getCloudEnv().CLOUD_DATABASE_URL;

    // Reset to a pre-migration state so the two runs actually RACE to create the
    // schema (the advisory lock is what's under test). Drop the cloud tables AND
    // the drizzle journal so the migrator believes nothing is applied.
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${CLOUD_TABLES.join(", ")} CASCADE`));
    await db.execute(sql.raw("DROP SCHEMA IF EXISTS drizzle CASCADE"));

    // Without the pg_advisory_lock one of these would crash with
    // "relation already exists"; with it they serialize (loser no-ops).
    await expect(Promise.all([migrateCloudDb(url), migrateCloudDb(url)])).resolves.toBeArray();

    // Schema is back and usable (table exists, empty).
    const [{ count }] = await db.execute(
      sql.raw("SELECT count(*)::int AS count FROM cloud_billing_accounts"),
    );
    expect(count).toBe(0);
  });
});

describe("migration chain upgrades", () => {
  // These cases replay the chain PARTIALLY (0000, then 0001, …), which leaves
  // the shared test database on an intermediate schema. Restore the full chain
  // afterwards or every test file that runs later sees the older shape — e.g. a
  // `cost_usd` still `double precision` (wrong rounding).
  afterAll(async () => {
    const db = getCloudDb();
    await resetToBlankSlate(db);
    await migrateCloudDb(getCloudEnv().CLOUD_DATABASE_URL);
  });

  it("0000 → 0001 re-keys usage records, backfills cost_usd, and drops the retry queue", async () => {
    const db = getCloudDb();
    await resetToBlankSlate(db);
    await applyMigration(db, "0000_init");

    // Seed legacy-shaped rows (0000 schema) via raw SQL — the Drizzle schema is
    // already the NEW (post-0001) shape.
    const org = "00000000-0000-4000-a000-0000000000aa";
    const runId = "run-legacy-1";
    await db.execute(sql.raw(`INSERT INTO cloud_billing_accounts (org_id) VALUES ('${org}')`));
    await db.execute(
      sql.raw(
        `INSERT INTO cloud_usage_records (org_id, run_id, cost_credits) VALUES ('${org}', '${runId}', 500)`,
      ),
    );
    await db.execute(
      sql.raw(`INSERT INTO cloud_billed_llm_usage (llm_usage_id, run_id) VALUES (1, '${runId}')`),
    );
    // cloud_pending_bills left EMPTY — the guard must let this migration through.

    await applyMigration(db, "0001_cursor_billing");

    // usage_records: run_id → (context_type, context_id); cost_usd backfilled to
    // the whole-credit equivalent; cost_credits intact.
    const [rec] = await db.execute(
      sql.raw(`SELECT context_type, context_id, cost_usd, cost_credits FROM cloud_usage_records`),
    );
    expect(rec!.context_type).toBe("run");
    expect(rec!.context_id).toBe(runId);
    expect(Number(rec!.cost_usd)).toBeCloseTo(0.5, 6);
    expect(rec!.cost_credits).toBe(500);

    // billed row survived; run_id column dropped.
    const [billed] = await db.execute(sql.raw("SELECT llm_usage_id FROM cloud_billed_llm_usage"));
    expect(billed!.llm_usage_id).toBe(1);
    const billedCols = await db.execute(
      sql.raw(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'cloud_billed_llm_usage'`,
      ),
    );
    expect(billedCols.map((c) => c.column_name)).not.toContain("run_id");

    // retry queue gone; cursor table present.
    const [{ pending }] = await db.execute(
      sql.raw("SELECT to_regclass('cloud_pending_bills') AS pending"),
    );
    expect(pending).toBeNull();
    const [{ cursor }] = await db.execute(
      sql.raw("SELECT to_regclass('cloud_billing_cursor') AS cursor"),
    );
    expect(cursor).not.toBeNull();
  });

  it("0001 → 0002 converts cost_usd to numeric without losing a stored value", async () => {
    const db = getCloudDb();
    await resetToBlankSlate(db);
    await applyMigration(db, "0000_init");
    await applyMigration(db, "0001_cursor_billing");

    const [before] = await db.execute(
      sql.raw(
        `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'cloud_usage_records' AND column_name = 'cost_usd'`,
      ),
    );
    expect(before!.data_type).toBe("double precision");

    // A pre-existing row must survive the type change with its value intact.
    const org = "00000000-0000-4000-a000-0000000000cc";
    await db.execute(sql.raw(`INSERT INTO cloud_billing_accounts (org_id) VALUES ('${org}')`));
    await db.execute(
      sql.raw(
        `INSERT INTO cloud_usage_records (org_id, context_type, context_id, cost_credits, cost_usd)
         VALUES ('${org}', 'run', 'run-0002', 25, 0.025)`,
      ),
    );

    await applyMigration(db, "0002_numeric_cost");

    const [after] = await db.execute(
      sql.raw(
        `SELECT data_type, numeric_scale FROM information_schema.columns
         WHERE table_name = 'cloud_usage_records' AND column_name = 'cost_usd'`,
      ),
    );
    expect(after!.data_type).toBe("numeric");
    expect(after!.numeric_scale).toBe(12);

    const [rec] = await db.execute(sql.raw(`SELECT cost_usd FROM cloud_usage_records`));
    expect(Number(rec!.cost_usd)).toBeCloseTo(0.025, 9);

    // Re-runnable: applying it a second time is a no-op, not an error.
    await applyMigration(db, "0002_numeric_cost");
  });

  it("0002 → 0003 normalizes legacy free accounts without an attached subscription", async () => {
    const db = getCloudDb();
    await resetToBlankSlate(db);
    await applyMigration(db, "0000_init");
    await applyMigration(db, "0001_cursor_billing");
    await applyMigration(db, "0002_numeric_cost");

    const canceledOrg = "00000000-0000-4000-a000-0000000000d1";
    const incompleteOrg = "00000000-0000-4000-a000-0000000000d2";
    const attachedOrg = "00000000-0000-4000-a000-0000000000d3";
    await db.execute(
      sql.raw(`
        INSERT INTO cloud_billing_accounts
          (org_id, plan_id, stripe_subscription_id, subscription_status, credits_used, credit_quota)
        VALUES
          ('${canceledOrg}', 'free', NULL, 'canceled', 0, 0),
          ('${incompleteOrg}', 'free', NULL, 'incomplete_expired', 0, 0),
          ('${attachedOrg}', 'starter', 'sub_attached', 'canceled', 100, 20000)
      `),
    );

    await applyMigration(db, "0003_normalize_free_subscription_status");

    const rows = await db.execute(
      sql.raw(`
        SELECT org_id, subscription_status, credits_used, credit_quota
        FROM cloud_billing_accounts
        ORDER BY org_id
      `),
    );
    expect(rows).toEqual([
      { org_id: canceledOrg, subscription_status: null, credits_used: 0, credit_quota: 0 },
      { org_id: incompleteOrg, subscription_status: null, credits_used: 0, credit_quota: 0 },
      {
        org_id: attachedOrg,
        subscription_status: "canceled",
        credits_used: 100,
        credit_quota: 20000,
      },
    ]);

    // Data-only and idempotent: a retry remains a no-op.
    await applyMigration(db, "0003_normalize_free_subscription_status");
  });

  it("0001 refuses to drop a non-empty cloud_pending_bills, then succeeds once drained", async () => {
    const db = getCloudDb();
    await resetToBlankSlate(db);
    await applyMigration(db, "0000_init");

    // A pending bill still awaiting retry — the guard must abort the migration
    // rather than silently destroy the unbilled work.
    const org = "00000000-0000-4000-a000-0000000000bb";
    await db.execute(
      sql.raw(
        `INSERT INTO cloud_pending_bills (run_id, org_id, model_source) VALUES ('run-x', '${org}', 'system')`,
      ),
    );

    await expect(applyMigration(db, "0001_cursor_billing")).rejects.toThrow(
      /cloud_pending_bills is not empty/,
    );

    // Drain the queue; re-applying now completes (proves the migration is
    // re-runnable after the guard's partial-apply failure).
    await db.execute(sql.raw("DELETE FROM cloud_pending_bills"));
    await applyMigration(db, "0001_cursor_billing");

    const [{ pending }] = await db.execute(
      sql.raw("SELECT to_regclass('cloud_pending_bills') AS pending"),
    );
    expect(pending).toBeNull();
  });
});
