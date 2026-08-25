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
 * ═══ WHAT THE CASES ARE FOR ═══
 *
 * The first three are the base contract, and they replay the guard's text
 * VERBATIM: zero offset is a no-op, non-zero offset over empty tables is a
 * no-op (this is every fresh install on a developer's non-UTC machine — the
 * guard must not ban them), and non-zero offset with data present raises.
 *
 * The rest are one per way the offset can be misread. It is a function of three
 * variables and each one has its own hole:
 *
 *   SEASONAL — `Europe/London` (and Dublin, Lisbon, Atlantic/Canary) is at
 *   +00:00 from late October to late March and +01:00 the rest of the year, so
 *   a guard reading ONE instant (`now()`) waves all 30 conversions through
 *   every winter while BST-written rows sit an hour ahead of UTC, and refuses
 *   the identical database every summer. Same data, opposite verdict by
 *   calendar.
 *
 *   HISTORICAL — probes pinned to a HARDCODED year read that year's rules, not
 *   today's. `Africa/Casablanca` was UTC+0 year-round until 2008 and has been
 *   permanently UTC+1 since 2018 (bar a Ramadan reversion each spring), so
 *   year-2000 probes read zero on both sides and pass a server that is an hour
 *   off right now.
 *
 *   RESOLUTION — `x AT TIME ZONE <text>` resolves the string against
 *   `pg_timezone_abbrevs` FIRST, while the `TimeZone` GUC that actually
 *   rendered the rows resolves against `pg_timezone_names` ONLY. `WET` is a
 *   fixed +00:00 ABBREVIATION and a seasonal +00:00/+01:00 ZONE NAME with
 *   Europe/Lisbon's rules, so a guard that hands the GUC's value back as a
 *   string reads zero on both probes and converts 30 columns on a server that
 *   was UTC+1 for seven months of the year. Measuring through `probe::timestamp`
 *   — the cast `DEFAULT now()` itself performs — closes it.
 *
 * `Etc/GMT0` is the control on all three: it must still PASS. A guard that
 * refuses everything is trivially free of every hole and useless.
 *
 * ═══ WHY THE BEHAVIOURAL CASES PIN A CLOCK ═══
 *
 * A regression test for a SEASONAL hole must not itself be seasonal. Replaying
 * a one-instant guard on `Europe/London` only tells the two guards apart
 * between late October and late March; run in July it is green against the very
 * shape it exists to reject, so for seven months a revert ships behind a green
 * suite. Same for `Africa/Casablanca`, whose Ramadan reversion to UTC+0 is the
 * ~5 weeks a year when a one-instant guard silently passes it.
 *
 * So each behavioural case ALSO replays the guard with `now()` pinned to a
 * fixed instant (`withClock`), chosen to sit inside the window where the
 * rejected shape reads zero. Those assertions are red against a one-instant
 * guard on every calendar date, not just the ones a maintainer happens to run
 * on. The verbatim replay is kept alongside so the pinned rewrite can never be
 * the only thing exercised.
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
 * Two things need this. The negative control asserts on what the guard
 * COMPUTES, and the guard carries a long comment that quotes the very
 * expressions being asserted about ("Hence `extract(year from now())` …") —
 * matching raw text would let a revert stay green on the strength of the prose
 * explaining why it must not happen, which is exactly what happened before this
 * existed. And `withClock` rewrites `now()`, which must not be hunted for
 * inside prose that merely discusses it.
 */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * The guard with its clock pinned: every `now()` in the DECLARE section — the
 * only place the guard is allowed to read a clock — replaced by a fixed
 * instant. This is what makes the seasonal cases below date-independent; see
 * the header.
 *
 * It throws rather than returning the text unchanged when there is no `now()`
 * to pin, because a silently un-pinned rewrite would turn every case built on
 * it into a test of today's date again — the precise failure being fixed.
 */
function withClock(guardSql: string, instant: string): string {
  const code = stripSqlComments(guardSql);
  const begin = code.search(/\bBEGIN\b/);
  if (begin === -1) throw new Error("guard has no BEGIN; cannot isolate its DECLARE section");
  const head = code.slice(0, begin);
  const pinned = head.replaceAll("now()", `('${instant}'::timestamptz)`);
  if (pinned === head) {
    throw new Error(
      "guard reads no clock in DECLARE; pinning would be a no-op and every " +
        "date-independent case below would silently revert to testing today's date",
    );
  }
  return pinned + code.slice(begin);
}

/**
 * Fixed instants, chosen so the shape each case rejects reads 00:00:00 at them.
 * Literals, never derived from the wall clock — that is the whole point.
 */
/** Europe/London and WET are both at +00:00 here; a one-instant guard passes. */
const JANUARY = "2026-01-15T12:00:00Z";
/** …and at +01:00 here, which is the half of the year that already worked. */
const JULY = "2026-07-15T12:00:00Z";
/** Africa/Casablanca reverts to UTC+0 for Ramadan (2026-02-15 → 2026-03-22). */
const CASABLANCA_RAMADAN = "2026-03-01T12:00:00Z";
/** Africa/Casablanca was genuinely UTC+0 year-round under its year-2000 rules. */
const MILLENNIUM = "2000-01-15T12:00:00Z";

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
 * The offset the session zone renders at mid-January or mid-July of `year`,
 * measured through `::timestamp` — the cast `DEFAULT now()` performs, and the
 * same quantity the guard's two probes compute.
 */
async function offsetAt(month: 1 | 7, year: number | "current"): Promise<string> {
  const y = year === "current" ? "extract(year from now())::int" : String(year);
  const probe = `make_timestamptz(${y}, ${month}, 15, 12, 0, 0, 'UTC')`;
  const r = await db.query<{ off: string }>(
    `SELECT (${probe}::timestamp - (${probe} AT TIME ZONE 'UTC'))::text AS off`,
  );
  return r.rows[0]!.off;
}

/**
 * The same offset read the WRONG way — by handing `current_setting('TimeZone')`
 * back to Postgres as a string, which resolves abbreviations first. For most
 * zones this agrees with `offsetAt`; where it does not, the guard would be
 * measuring an object that never rendered a row.
 */
async function offsetViaZoneNameString(month: 1 | 7, year: number | "current"): Promise<string> {
  const y = year === "current" ? "extract(year from now())::int" : String(year);
  const probe = `make_timestamptz(${y}, ${month}, 15, 12, 0, 0, 'UTC')`;
  const r = await db.query<{ off: string }>(
    `SELECT ((${probe} AT TIME ZONE current_setting('TimeZone'))` +
      ` - (${probe} AT TIME ZONE 'UTC'))::text AS off`,
  );
  return r.rows[0]!.off;
}

/** What a real `DEFAULT now()` column stores right now, relative to true UTC. */
async function defaultNowOffset(): Promise<string> {
  await db.exec(`DROP TABLE IF EXISTS public.default_now_probe;
    CREATE TABLE public.default_now_probe (id int, ts timestamp DEFAULT now());`);
  const r = await db.query<{ off: string }>(
    `INSERT INTO public.default_now_probe (id) VALUES (1)
     RETURNING (ts - (now() AT TIME ZONE 'UTC'))::text AS off`,
  );
  return r.rows[0]!.off;
}

async function runGuard(text: string = guard): Promise<{ raised: boolean; message: string }> {
  try {
    await db.exec(text);
    return { raised: false, message: "" };
  } catch (err) {
    return { raised: true, message: err instanceof Error ? err.message : String(err) };
  }
}

describe("0047 UTC guard", () => {
  it("is a no-op when the server renders now() in UTC, even with rows present", async () => {
    await reset("UTC", true);
    expect(await defaultNowOffset()).toBe("00:00:00");
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
    expect(await defaultNowOffset()).not.toBe("00:00:00");
    const result = await runGuard();
    expect(result.raised).toBe(true);
    // The operator has to be able to act on it: which zone, how far off, and
    // which tables are holding the rows that would move.
    expect(result.message).toContain("Europe/Paris");
    expect(result.message).toContain("webhooks");
  });

  it("is still a no-op on a zero-offset DST zone while the at-risk tables are empty", async () => {
    // The corrections must not overshoot into a blanket ban: a fresh install on
    // a London machine has nothing to move, exactly like the Paris case above.
    // Asserted on both sides of the DST year so this cannot pass by season.
    await reset("Europe/London", false);
    expect(await runGuard()).toEqual({ raised: false, message: "" });
    for (const clock of [JANUARY, JULY]) {
      expect(await runGuard(withClock(guard, clock))).toEqual({ raised: false, message: "" });
    }
  });

  it("refuses a seasonal zone on the side of the year where it reads as UTC", async () => {
    await reset("Europe/London", true);

    // The hole, stated as an assertion rather than as prose: for five months of
    // the year London IS UTC, so a probe taken at a single instant reads
    // exactly 00:00:00 — while the rows written through `DEFAULT now()` during
    // BST are stored an hour ahead of UTC and `AT TIME ZONE 'UTC'` would move
    // them permanently late.
    expect(await offsetAt(1, "current")).toBe("00:00:00");
    expect(await offsetAt(7, "current")).toBe("01:00:00");

    // JANUARY is the load-bearing one: it is inside the window where a
    // one-instant guard reads zero and returns early, so this assertion is red
    // against that shape on every calendar date rather than only in winter.
    // JULY is the mirror, where such a guard happens to be right.
    for (const clock of [JANUARY, JULY]) {
      const result = await runGuard(withClock(guard, clock));
      expect(result.raised).toBe(true);
      expect(result.message).toContain("Europe/London");
      expect(result.message).toContain("webhooks");
    }

    // …and verbatim, with no clock rewriting at all.
    expect((await runGuard()).raised).toBe(true);
  });

  it("refuses a zone that reads as UTC by ABBREVIATION but is seasonal by NAME", async () => {
    // The resolution hole. `WET` is settable as a `TimeZone` and renders the
    // Europe/Lisbon rules, but the same three letters are ALSO a fixed +00:00
    // entry in pg_timezone_abbrevs — so measuring the offset by feeding
    // `current_setting('TimeZone')` back to Postgres as a string reads a
    // different object than the one that wrote every row.
    await reset("WET", true);

    // What actually rendered the rows: seasonal, an hour off for seven months.
    expect(await offsetAt(1, "current")).toBe("00:00:00");
    expect(await offsetAt(7, "current")).toBe("01:00:00");

    // What the zone-name string reports: fixed zero, on BOTH sides. A guard
    // reading this returns early and converts all 30 columns.
    expect(await offsetViaZoneNameString(1, "current")).toBe("00:00:00");
    expect(await offsetViaZoneNameString(7, "current")).toBe("00:00:00");

    for (const clock of [JANUARY, JULY]) {
      const result = await runGuard(withClock(guard, clock));
      expect(result.raised).toBe(true);
      expect(result.message).toContain("WET");
      expect(result.message).toContain("webhooks");
    }

    expect((await runGuard()).raised).toBe(true);
  });

  it("judges a zone on the rules in force at the clock, not at a hardcoded year", async () => {
    // The historical hole. Africa/Casablanca ran UTC+0 year-round until 2008
    // and has been permanently UTC+1 since 2018, so the zone's own history
    // decides the verdict unless the probe year tracks the clock.
    await reset("Africa/Casablanca", true);

    // Probed under the rules of 2000: zero on BOTH sides. A guard pinned there
    // returns early and converts 30 columns on a server that is an hour off.
    expect(await offsetAt(1, 2000)).toBe("00:00:00");
    expect(await offsetAt(7, 2000)).toBe("00:00:00");

    // Probed under today's rules: an hour off, both sides. (This also confirms
    // PGlite's tzdata carries the 2018 rule; without it both readings here
    // would be 00:00:00 and this case would be proving nothing.)
    expect(await offsetAt(1, "current")).toBe("01:00:00");
    expect(await offsetAt(7, "current")).toBe("01:00:00");

    // Casablanca reverts to UTC+0 for Ramadan — 2026-02-15 to 2026-03-22 — so
    // CASABLANCA_RAMADAN is an instant at which a one-instant guard reads zero
    // and waves the conversion through. Pinned there, this is red against that
    // shape all year instead of for the ~5 weeks the window is open.
    const ramadan = await runGuard(withClock(guard, CASABLANCA_RAMADAN));
    expect(ramadan.raised).toBe(true);
    expect(ramadan.message).toContain("Africa/Casablanca");
    expect(ramadan.message).toContain("webhooks");

    // The other side of the same requirement, and what makes the assertion
    // above two-sided: pinned to a clock that really is in 2000, the guard must
    // judge Casablanca by ITS rules and pass. A guard with the year hardcoded
    // fails one of these two whichever year it hardcodes.
    expect(await runGuard(withClock(guard, MILLENNIUM))).toEqual({ raised: false, message: "" });

    expect((await runGuard()).raised).toBe(true);
  });

  it("still accepts PGlite's Etc/GMT0 with rows present", async () => {
    // The control on all three corrections. PGlite derives its default TimeZone
    // from the host and reports fixed-offset names, so `Etc/GMT0` is what a
    // correctly-configured tier 0-1 install actually reports — a guard that
    // refused it would fail every such install, and a guard that refuses
    // everything is trivially free of every hole and useless.
    await reset("Etc/GMT0", true);
    expect(await offsetAt(1, "current")).toBe("00:00:00");
    expect(await offsetAt(7, "current")).toBe("00:00:00");
    expect(await defaultNowOffset()).toBe("00:00:00");
    expect(await runGuard()).toEqual({ raised: false, message: "" });
    for (const clock of [JANUARY, JULY, MILLENNIUM]) {
      expect(await runGuard(withClock(guard, clock))).toEqual({ raised: false, message: "" });
    }
  });

  it("still finds a guard to run", () => {
    // Negative control. If the block is renamed, moved, deleted or reverted,
    // the cases above must not pass by replaying an empty string or a shape
    // they cannot see.
    //
    // EVERY assertion here runs on the guard with comments stripped. On raw
    // text a revert of the DO block would stay green purely on the strength of
    // the prose explaining why it must not happen — the block quotes its own
    // expressions by name, so `toContain("winter_offset")` matched the comment
    // and not the code. Checked, and it did exactly that.
    const code = stripSqlComments(guard);

    expect(code).toContain("RAISE EXCEPTION");

    // Two probes, not one.
    expect(code).toContain("winter_offset");
    expect(code).toContain("summer_offset");

    // The probe YEAR must come from the clock, or the historical hole reopens.
    expect(code).toMatch(/extract\(\s*year\s+from\s+now\(\)\s*\)/i);

    // …and the OFFSET must never be read at `now()`, which is the seasonal
    // hole. The distinction is exactly this: `now()` may be consumed as a
    // source of the year, never as the instant an offset is measured at. Any
    // offset read anchored at now() has to bring `now()` (optionally cast) up
    // against `AT TIME ZONE` or a subtraction, so that is what this forbids —
    // it stays red for `now()::timestamp - (...)` and for
    // `now() AT TIME ZONE 'UTC'` alike, while `extract(year from now())` passes.
    expect(code).not.toMatch(/now\(\)\s*(::\s*\w+)?\s*(AT\s+TIME\s+ZONE|-)/i);

    // …and the offset must be measured through the cast the writer used, never
    // by handing the GUC's value back as a string: that resolves abbreviations
    // first and reads a different object for `WET`. This is the resolution
    // hole, and the WET case above is its behavioural half.
    expect(code).not.toMatch(/AT\s+TIME\s+ZONE\s+(server_tz|current_setting)/i);

    expect(code.trim().length).toBeGreaterThan(500);
  });
});
