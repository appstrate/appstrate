// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0045_drop_integration_refresh_failure_timestamp` — the
 * integration-side twin of the two write-only columns 0044 dropped.
 *
 * `0044`'s test asserts the catalog no longer carries the columns it dropped;
 * this file does the same for `0045`, which had no assertion of its own. On its
 * own that check is weak — the boot chain already applied the migration, so an
 * EMPTY file would pass it. So the drop is also exercised directly: a
 * transaction puts the column back, replays the real SQL file, and asserts it
 * goes away again, then rolls back. Postgres DDL is transactional, so the
 * suite's schema is untouched either way.
 *
 * `refresh_failure_count` is asserted PRESENT throughout. It is the counter the
 * `needs_reconnection` escalation actually reads, and it sits beside the dropped
 * timestamp in the same writer — a drop that took both would be silent here and
 * loud only in production.
 */

import { describe, it, expect } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";

const MIGRATION = new URL(
  "../../../../../packages/db/drizzle/0045_drop_integration_refresh_failure_timestamp.sql",
  import.meta.url,
).pathname;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Rolls the enclosing transaction back. Never escapes `inRewoundSchema`. */
class Rollback extends Error {}

async function replayMigration(executor: Pick<Tx, "execute">): Promise<void> {
  const source = await Bun.file(MIGRATION).text();
  for (const statement of source.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (!trimmed) continue;
    await executor.execute(sql.raw(trimmed));
  }
}

async function integrationColumns(executor: Pick<Tx, "execute">): Promise<string[]> {
  const result = await executor.execute(sql`
    SELECT column_name AS name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'integration_connections'
      AND column_name IN ('last_refresh_failure_at', 'refresh_failure_count')
    ORDER BY column_name
  `);
  // `db.execute` yields `{ rows }` on PGlite and a bare array on postgres.js.
  const rows = ((result as { rows?: unknown[] }).rows ?? result) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe("migration 0045 — drop the integration refresh-failure timestamp", () => {
  it("the catalog no longer carries the column, and still carries the counter", async () => {
    expect(await integrationColumns(db)).toEqual(["refresh_failure_count"]);
  });

  it("the DROP fires: a database still carrying the column loses it on replay", async () => {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          ALTER TABLE "integration_connections"
          ADD COLUMN "last_refresh_failure_at" timestamp with time zone
        `);
        expect(await integrationColumns(tx)).toEqual([
          "last_refresh_failure_at",
          "refresh_failure_count",
        ]);

        await replayMigration(tx);
        expect(await integrationColumns(tx)).toEqual(["refresh_failure_count"]);

        // `IF EXISTS`, so a partially-migrated environment converges rather than
        // erroring on the second pass.
        await replayMigration(tx);
        expect(await integrationColumns(tx)).toEqual(["refresh_failure_count"]);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });
});
