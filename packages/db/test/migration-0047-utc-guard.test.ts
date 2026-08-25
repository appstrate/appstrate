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
 * Five cases. The first three are the base contract: zero offset is a no-op,
 * non-zero offset over empty tables is a no-op (this is every fresh install on
 * a developer's non-UTC machine — the guard must not ban them), and non-zero
 * offset with data present raises.
 *
 * The remaining four are the two ways a zone's offset can be misread, because
 * that offset is a function of TWO variables and each one has its own hole.
 *
 * SEASONAL — `Europe/London` (and Dublin, Lisbon, Atlantic/Canary) is at +00:00
 * from late October to late March and +01:00 the rest of the year, so a guard
 * reading ONE instant (`now()`) waves all 30 conversions through every winter
 * while BST-written rows sit an hour ahead of UTC, and refuses the identical
 * database every summer. Same data, opposite verdict by calendar. Two probes,
 * one per season, close it — London must fail closed whatever month this runs
 * in, and must still be a no-op while the tables are empty.
 *
 * HISTORICAL — two probes pinned to a HARDCODED year read that year's rules,
 * not today's. `Africa/Casablanca` was UTC+0 year-round until 2008 and has been
 * permanently UTC+1 since 2018, so year-2000 probes read zero on both sides and
 * pass a server that is an hour off right now. Deriving the probe year from
 * `now()` closes it.
 *
 * `Etc/GMT0` is the control on both corrections: it must still PASS. A guard
 * that refuses everything is trivially free of both holes and useless.
 *
 * PGlite carries full tzdata and preserves a named zone across `SET TimeZone`
 * (verified: `Europe/London` reports itself by name and yields 00:00:00 in
 * January against 01:00:00 in July; `Africa/Casablanca` yields 00:00:00 at both
 * year-2000 probes against 01:00:00 at both current-year probes, so its
 * post-2018 rule is present), so these cases exercise real tzdata rather than a
 * fixed-offset stand-in.
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

/**
 * The guard's EXECUTABLE text, with `--` comments removed.
 *
 * The negative control below asserts on what the guard computes, and the guard
 * carries a long comment that quotes the very expressions being asserted about
 * ("Hence `extract(year from now())` …"). Matching the raw text would let a
 * revert stay green purely on the strength of the prose explaining why it must
 * not happen — checked, and it did exactly that before this existed.
 */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

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

/**
 * The offset the session zone renders at mid-January or mid-July of `year` —
 * the same quantity the guard's two probes compute. `year: "current"` derives
 * it from `now()` exactly as the guard does.
 */
async function offsetAt(month: 1 | 7, year: number | "current"): Promise<string> {
  const y = year === "current" ? "extract(year from now())::int" : String(year);
  const probe = `make_timestamptz(${y}, ${month}, 15, 12, 0, 0, 'UTC')`;
  const r = await db.query<{ off: string }>(
    `SELECT (${probe} AT TIME ZONE current_setting('TimeZone')` +
      ` - ${probe} AT TIME ZONE 'UTC')::text AS off`,
  );
  return r.rows[0]!.off;
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

  it("is still a no-op on a zero-offset DST zone while the at-risk tables are empty", async () => {
    // The correction must not overshoot into a blanket ban: a fresh install on
    // a London machine has nothing to move, exactly like the Paris case above.
    await reset("Europe/London", false);
    expect(await runGuard()).toEqual({ raised: false, message: "" });
  });

  it("raises on a zero-offset DST zone regardless of which side of the DST year it is", async () => {
    await reset("Europe/London", true);

    // The hole, stated as an assertion rather than as prose: for five months of
    // the year London IS UTC, so a probe taken at a single instant reads
    // exactly 00:00:00 and the guard returns early — while the rows written
    // through `DEFAULT now()` during BST are stored an hour ahead of UTC and
    // `AT TIME ZONE 'UTC'` would move them permanently late.
    expect(await offsetAt(1, "current")).toBe("00:00:00");
    expect(await offsetAt(7, "current")).toBe("01:00:00");

    // Both probes must be zero to pass, so the verdict no longer depends on
    // when this runs.
    const result = await runGuard();
    expect(result.raised).toBe(true);
    expect(result.message).toContain("Europe/London");
    expect(result.message).toContain("webhooks");
  });

  it("raises on a zone whose rules CHANGED since a hardcoded probe year would have looked", async () => {
    // The second hole, and the one two fixed year-2000 probes do not close.
    // Africa/Casablanca ran UTC+0 year-round until 2008 and has been
    // permanently UTC+1 since 2018, so the zone's own history decides the
    // verdict unless the probe year tracks the clock.
    await reset("Africa/Casablanca", true);

    // Probed under the rules of 2000: zero on BOTH sides. A guard pinned there
    // returns early and converts 30 columns on a server that is an hour off.
    expect(await offsetAt(1, 2000)).toBe("00:00:00");
    expect(await offsetAt(7, 2000)).toBe("00:00:00");

    // Probed under today's rules — which is what the guard does: an hour off,
    // both sides. (This also confirms PGlite's tzdata carries the 2018 rule;
    // without it both readings here would be 00:00:00 and this test would be
    // proving nothing.)
    expect(await offsetAt(1, "current")).toBe("01:00:00");
    expect(await offsetAt(7, "current")).toBe("01:00:00");

    const result = await runGuard();
    expect(result.raised).toBe(true);
    expect(result.message).toContain("Africa/Casablanca");
    expect(result.message).toContain("webhooks");
  });

  it("still accepts PGlite's Etc/GMT0 with rows present", async () => {
    // The control on BOTH corrections. PGlite derives its default TimeZone from
    // the host and reports fixed-offset names, so `Etc/GMT0` is what a
    // correctly-configured tier 0-1 install actually reports — a guard that
    // refused it would fail every such install, and a guard that refuses
    // everything is trivially free of both holes and useless.
    await reset("Etc/GMT0", true);
    expect(await offsetAt(1, "current")).toBe("00:00:00");
    expect(await offsetAt(7, "current")).toBe("00:00:00");
    expect(await runGuard()).toEqual({ raised: false, message: "" });
  });

  it("still finds a guard to run", () => {
    // Negative control. If the block is renamed, moved or deleted, the three
    // assertions above must not pass by replaying an empty string.
    expect(guard).toContain("RAISE EXCEPTION");

    // Both probes, not one.
    expect(guard).toContain("winter_offset");
    expect(guard).toContain("summer_offset");

    // Everything below is about what the guard COMPUTES, so it runs against the
    // code with comments stripped — see stripSqlComments for why that matters.
    const code = stripSqlComments(guard);

    // The probe YEAR must come from the clock, or the historical hole reopens
    // and no assertion above can see it (the Casablanca case reads the zone
    // directly, not through the guard's own expression).
    expect(code).toMatch(/extract\(\s*year\s+from\s+now\(\)\s*\)/i);

    // …and the OFFSET must never be read at `now()`, which is the other hole.
    // The distinction is exactly this: `now()` may be consumed as a source of
    // the year, never as the instant an offset is measured at. Any offset read
    // anchored at now() has to bring `now()` (optionally cast) up against
    // `AT TIME ZONE` or a subtraction, so that is what this forbids — it stays
    // red for `now()::timestamp - (...)` and for `now() AT TIME ZONE 'UTC'`
    // alike, while `extract(year from now())` passes it.
    expect(code).not.toMatch(/now\(\)\s*(::\s*\w+)?\s*(AT\s+TIME\s+ZONE|-)/i);

    expect(guard.length).toBeGreaterThan(500);
  });
});
