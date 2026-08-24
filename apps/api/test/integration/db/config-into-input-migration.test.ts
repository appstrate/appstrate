// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0040_config_into_input` — folding the `config` parameter namespace
 * into `input`.
 *
 * The chain is replayed at boot by the tier-0 harness, so a syntactically broken
 * migration already fails every integration test. What that does NOT prove is
 * that this one moves the right bytes: it runs against an empty database, where
 * a wrap that fires on every row and a wrap that fires on none are
 * indistinguishable.
 *
 * The stake is asymmetric in both directions, which is why this file exists:
 *
 *   * wrap too little and `application_packages.input_settings` keeps a raw
 *     `config` object, `getInstalledPackageSettings` resolves `asRecord(…)` to
 *     `{}`, and every configured input value is silently gone;
 *   * wrap too much and every row nests a second time into
 *     `{"values":{"values":…,"locked":[]},"locked":[]}`.
 *
 * A guard added on this branch and reverted here took the first of those: it
 * skipped rows whose stored object already carried `values` + an array `locked`,
 * which is a shape an AGENT can declare — `config` held arbitrary
 * author-declared parameter names. The adversarial row below is that case, and
 * it is the reason the wrap is unconditional. See the migration's own header.
 *
 * Replaying against the LIVE test database is not possible as-is: `config`,
 * `config_override` and `runs.config` are exactly what this migration drops. So
 * each case opens a transaction, puts the three tables back into their pre-0040
 * shape inside it, replays the real SQL file, asserts, and rolls the whole thing
 * back — Postgres DDL is transactional, so the suite's schema is untouched
 * whether the case passes or throws.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";

const MIGRATION = new URL(
  "../../../../../packages/db/drizzle/0040_config_into_input.sql",
  import.meta.url,
).pathname;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Rolls the enclosing transaction back. Never escapes `inPre0040Schema`. */
class Rollback extends Error {}

/** `db.execute` yields `{ rows }` on the PGlite driver and a bare array on postgres.js. */
function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: unknown[] }).rows ?? result) as T[];
}

/**
 * Run `body` against a schema rewound to just before 0040, then roll back.
 *
 * The rewind is the exact inverse of the migration's DDL, and nothing more: the
 * fold and the wrap are what the test is about, so they must be performed by the
 * migration file itself, never by this helper.
 */
async function inPre0040Schema(body: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`ALTER TABLE "application_packages" RENAME COLUMN "input_settings" TO "config"`,
      );
      await tx.execute(
        sql`ALTER TABLE "application_packages" ALTER COLUMN "config" SET DEFAULT '{}'::jsonb`,
      );
      await tx.execute(sql`ALTER TABLE "package_schedules" ADD COLUMN "config_override" jsonb`);
      await tx.execute(sql`ALTER TABLE "runs" ADD COLUMN "config" jsonb`);
      await tx.execute(sql`ALTER TABLE "runs" ADD COLUMN "config_override" jsonb`);
      await body(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

async function replayMigration(tx: Tx): Promise<void> {
  const source = await Bun.file(MIGRATION).text();
  for (const statement of source.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (!trimmed) continue;
    await tx.execute(sql.raw(trimmed));
  }
}

// ─── pre-0040 seeding, in raw SQL ────────────────────────────────────────────
// The Drizzle schema describes the POST-migration shape, so every write below
// names its columns explicitly rather than going through a seed helper.

async function installWithConfig(
  tx: Tx,
  applicationId: string,
  packageId: string,
  config: unknown,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO "application_packages" ("application_id", "package_id", "config")
    VALUES (${applicationId}, ${packageId}, ${JSON.stringify(config)}::jsonb)
  `);
}

async function settingsOf(tx: Tx, packageId: string): Promise<unknown> {
  const rows = rowsOf<{ input_settings: unknown }>(
    await tx.execute(
      sql`SELECT "input_settings" FROM "application_packages" WHERE "package_id" = ${packageId}`,
    ),
  );
  return rows[0]!.input_settings;
}

async function seedScheduleWithOverride(
  tx: Tx,
  ctx: TestContext,
  packageId: string,
  input: unknown,
  configOverride: unknown,
): Promise<string> {
  const id = `sched_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  // `package_schedules_exactly_one_actor` — a schedule fires as a member OR as
  // an end-user, never as neither.
  await tx.execute(sql`
    INSERT INTO "package_schedules"
      ("id", "package_id", "user_id", "org_id", "application_id", "cron_expression",
       "input", "config_override")
    VALUES (
      ${id}, ${packageId}, ${ctx.user.id}, ${ctx.orgId}, ${ctx.defaultAppId}, '0 * * * *',
      ${input === null ? null : JSON.stringify(input)}::jsonb,
      ${configOverride === null ? null : JSON.stringify(configOverride)}::jsonb
    )
  `);
  return id;
}

async function scheduleInputOf(tx: Tx, id: string): Promise<unknown> {
  const rows = rowsOf<{ input: unknown }>(
    await tx.execute(sql`SELECT "input" FROM "package_schedules" WHERE "id" = ${id}`),
  );
  return rows[0]!.input;
}

async function seedRunWithConfig(
  tx: Tx,
  ctx: TestContext,
  packageId: string,
  input: unknown,
  config: unknown,
): Promise<string> {
  const id = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await tx.execute(sql`
    INSERT INTO "runs" ("id", "package_id", "org_id", "application_id", "input", "config")
    VALUES (
      ${id}, ${packageId}, ${ctx.orgId}, ${ctx.defaultAppId},
      ${input === null ? null : JSON.stringify(input)}::jsonb,
      ${config === null ? null : JSON.stringify(config)}::jsonb
    )
  `);
  return id;
}

async function runInputOf(tx: Tx, id: string): Promise<unknown> {
  const rows = rowsOf<{ input: unknown }>(
    await tx.execute(sql`SELECT "input" FROM "runs" WHERE "id" = ${id}`),
  );
  return rows[0]!.input;
}

async function columnExists(tx: Tx, table: string, column: string): Promise<boolean> {
  const rows = rowsOf<unknown>(
    await tx.execute(sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    `),
  );
  return rows.length > 0;
}

describe("migration 0040 — fold the `config` namespace into `input`", () => {
  let ctx: TestContext;
  const PLAIN = "@migration0040/plain-agent";
  const ADVERSARIAL = "@migration0040/adversarial-agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "config-into-input" });
    // Seeded on the OUTER connection: the transaction each case opens cannot see
    // rows another connection has not committed, and the FK would reject them.
    await seedPackage({ id: PLAIN, orgId: ctx.orgId });
    await seedPackage({ id: ADVERSARIAL, orgId: ctx.orgId });
  });

  it("wraps stored values under `values`, with `locked` starting empty", async () => {
    await inPre0040Schema(async (tx) => {
      await installWithConfig(tx, ctx.defaultAppId, PLAIN, { region: "eu-west", retries: 3 });

      await replayMigration(tx);

      expect(await settingsOf(tx, PLAIN)).toEqual({
        values: { region: "eu-west", retries: 3 },
        locked: [],
      });
    });
  });

  it("wraps a row whose author-declared parameters are named `values` and `locked`", async () => {
    // THE REGRESSION. `config` held arbitrary author-declared parameter names,
    // so this object is a legitimate un-wrapped row that happens to look wrapped.
    // Any `WHERE NOT (input_settings ? 'values' AND …)` guard skips it, and the
    // agent's configured values are then unreachable: `asRecord("prod")` is `{}`,
    // and `locked` reads as `["eu-west"]` — a lock on a field that never existed.
    await inPre0040Schema(async (tx) => {
      await installWithConfig(tx, ctx.defaultAppId, ADVERSARIAL, {
        values: "prod",
        locked: ["eu-west"],
      });

      await replayMigration(tx);

      expect(await settingsOf(tx, ADVERSARIAL)).toEqual({
        values: { values: "prod", locked: ["eu-west"] },
        locked: [],
      });
    });
  });

  it("folds `package_schedules.config_override` into `input`, letting `input` win", async () => {
    await inPre0040Schema(async (tx) => {
      const both = await seedScheduleWithOverride(
        tx,
        ctx,
        PLAIN,
        { shared: "from-input", only_input: 1 },
        { shared: "from-config", only_config: 2 },
      );
      const overrideOnly = await seedScheduleWithOverride(tx, ctx, PLAIN, null, { only: "config" });
      const neither = await seedScheduleWithOverride(tx, ctx, PLAIN, { untouched: true }, null);

      await replayMigration(tx);

      expect(await scheduleInputOf(tx, both)).toEqual({
        shared: "from-input",
        only_input: 1,
        only_config: 2,
      });
      expect(await scheduleInputOf(tx, overrideOnly)).toEqual({ only: "config" });
      // No override to fold: the row must not be rewritten, not even to `{}`.
      expect(await scheduleInputOf(tx, neither)).toEqual({ untouched: true });
      expect(await columnExists(tx, "package_schedules", "config_override")).toBe(false);
    });
  });

  it("folds `runs.config` into `input` before dropping both run columns", async () => {
    await inPre0040Schema(async (tx) => {
      const configOnly = await seedRunWithConfig(tx, ctx, PLAIN, null, { only: "config" });
      const both = await seedRunWithConfig(
        tx,
        ctx,
        PLAIN,
        { shared: "from-input" },
        { shared: "from-config", extra: true },
      );

      await replayMigration(tx);

      // A config-only agent had `input` NULL; dropping bare would have erased
      // every record of what the run actually executed with.
      expect(await runInputOf(tx, configOnly)).toEqual({ only: "config" });
      expect(await runInputOf(tx, both)).toEqual({ shared: "from-input", extra: true });
      expect(await columnExists(tx, "runs", "config")).toBe(false);
      expect(await columnExists(tx, "runs", "config_override")).toBe(false);
    });
  });

  it("re-running raises no error, and folds nothing a second time", async () => {
    await inPre0040Schema(async (tx) => {
      const schedule = await seedScheduleWithOverride(tx, ctx, PLAIN, { a: 1 }, { b: 2 });
      const run = await seedRunWithConfig(tx, ctx, PLAIN, null, { c: 3 });

      await replayMigration(tx);
      const afterFirst = {
        schedule: await scheduleInputOf(tx, schedule),
        run: await runInputOf(tx, run),
      };

      // The catalog-guarded RENAME, the two column-gated folds and the
      // `IF EXISTS` drops all converge, so a partially-applied environment can
      // be finished by re-running the file.
      await replayMigration(tx);

      expect(await scheduleInputOf(tx, schedule)).toEqual(afterFirst.schedule);
      expect(await runInputOf(tx, run)).toEqual(afterFirst.run);
    });
  });

  it("the `application_packages` wrap is one-shot — a replay nests it again", async () => {
    // Recorded, not endorsed. This is the cost of an unconditional wrap, and it
    // is paid by nobody: drizzle's pg dialect applies migrations by TIMESTAMP
    // WATERMARK and `applyCorePGliteMigrations` by journal TAG, so editing this
    // file never makes a database replay it.
    //
    // The tripwire this pins is the fix: a "does this row already look wrapped?"
    // predicate would make this test pass and the adversarial case above FAIL.
    // There is no sound shape test — the two are the same bytes.
    await inPre0040Schema(async (tx) => {
      await installWithConfig(tx, ctx.defaultAppId, PLAIN, { region: "eu-west" });

      await replayMigration(tx);
      await replayMigration(tx);

      expect(await settingsOf(tx, PLAIN)).toEqual({
        values: { values: { region: "eu-west" }, locked: [] },
        locked: [],
      });
    });
  });
});
