// SPDX-License-Identifier: Apache-2.0

/**
 * `0047_timestamptz_oidc_webhooks.sql` converts 30 naive `timestamp` columns
 * with `USING col AT TIME ZONE 'UTC'`, which asserts that every stored value is
 * a UTC wall clock. That is true of the rows the application wrote (postgres.js
 * sends a `Date` as `.toISOString()`), and NOT true of the 17 columns whose
 * `DEFAULT now()` is the insert writer: `now()::timestamp` renders in the
 * server's `TimeZone` GUC. On a non-UTC server the conversion moves those
 * instants by the server's offset, permanently and with nothing to undo it
 * from.
 *
 * The migration therefore opens with a guard that refuses to run when the
 * server does not render `now()` in UTC and any at-risk table already holds
 * rows. This file replays THAT block — read out of the shipped `.sql`, never
 * copied — against a throwaway in-memory PGlite, so the guard cannot be
 * weakened in the migration and stay green here.
 *
 * Three cases, and the third is the one that matters: zero offset is a no-op,
 * non-zero offset over empty tables is a no-op (this is every fresh install on
 * a developer's non-UTC machine — the guard must not ban them), and non-zero
 * offset with data present raises.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = resolve(import.meta.dir, "../drizzle/0047_timestamptz_oidc_webhooks.sql");

/**
 * The guard is the migration's only `DO $$ … END $$;` block. Extracted rather
 * than duplicated: a copy would drift, and a test that passes against a copy
 * proves nothing about what ships.
 */
function extractGuard(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf("DO $$");
  const end = sql.indexOf("END $$;", start);
  if (start === -1 || end === -1) throw new Error("guard block not found in 0047");
  return sql.slice(start, end + "END $$;".length);
}

/** The eleven tables the guard probes, per its own `FOREACH` list. */
const AT_RISK = [
  "application_smtp_configs",
  "application_social_providers",
  "cli_refresh_tokens",
  "jwks",
  "oauth_access_tokens",
  "oauth_clients",
  "oauth_consents",
  "oauth_refresh_tokens",
  "oidc_end_user_profiles",
  "webhook_deliveries",
  "webhooks",
];

let db: PGlite;
let guard: string;

beforeAll(async () => {
  guard = extractGuard();
  db = new PGlite();
  await db.waitReady;
});

afterAll(async () => {
  await db.close();
});

/**
 * Stand-ins for the eleven tables. The guard only asks each one whether it has
 * a row, so a single column is the whole contract it depends on — reproducing
 * the real DDL here would couple this test to columns it never reads.
 */
async function reset(timeZone: string, seed: boolean): Promise<void> {
  await db.exec(`SET TimeZone='${timeZone}';`);
  for (const t of AT_RISK) {
    await db.exec(`DROP TABLE IF EXISTS public.${t}; CREATE TABLE public.${t} (id text);`);
  }
  if (seed) await db.exec(`INSERT INTO public.webhooks (id) VALUES ('wh_1');`);
}

async function runGuard(): Promise<{ raised: boolean; message: string }> {
  try {
    await db.exec(guard);
    return { raised: false, message: "" };
  } catch (err) {
    return { raised: true, message: err instanceof Error ? err.message : String(err) };
  }
}

describe("0047 UTC guard", () => {
  it("is a no-op when the server renders now() in UTC, even with rows present", async () => {
    await reset("UTC", true);
    const offset = await db.query<{ off: string }>(
      "SELECT (now()::timestamp - (now() AT TIME ZONE 'UTC'))::text AS off",
    );
    expect(offset.rows[0]!.off).toBe("00:00:00");
    expect(await runGuard()).toEqual({ raised: false, message: "" });
  });

  it("is a no-op on a non-UTC server while the at-risk tables are empty", async () => {
    // Every fresh install on a developer machine outside UTC: 0000-0052 replay
    // in one batch with these tables empty, so no row can be moved.
    await reset("Europe/Paris", false);
    expect(await runGuard()).toEqual({ raised: false, message: "" });
  });

  it("raises on a non-UTC server once an at-risk table holds a row", async () => {
    await reset("Europe/Paris", true);
    const result = await runGuard();
    expect(result.raised).toBe(true);
    // The operator has to be able to act on it: which zone, how far off, and
    // which tables are holding the rows that would move.
    expect(result.message).toContain("Europe/Paris");
    expect(result.message).toContain("webhooks");
  });

  it("still finds a guard to run", () => {
    // Negative control. If the block is renamed, moved or deleted, the three
    // assertions above must not pass by replaying an empty string.
    expect(guard).toContain("RAISE EXCEPTION");
    expect(guard).toContain("rendered_offset");
    expect(guard.length).toBeGreaterThan(500);
  });
});
