// SPDX-License-Identifier: Apache-2.0

/**
 * Every timestamp column in the core schema must be `timestamptz`.
 *
 * Migration `0047_timestamptz_oidc_webhooks.sql` converted the last 30 naive
 * `timestamp` columns. This file exists so the 31st cannot appear.
 *
 * The failure it guards is not cosmetic. postgres.js writes a JS `Date` as
 * `.toISOString()` — a UTC wall clock — and a naive column drops the zone;
 * reading back gives the space-separated form, which `new Date(x)` parses as
 * LOCAL time. Every write→read round trip through a naive column shifts by the
 * process's UTC offset, and no `TZ` is pinned in the Dockerfile, the compose
 * files or the entrypoint. On an expiry column compared in JS
 * (`row.expiresAt < new Date()`) that shift is an auth defect, not a display
 * one: east of UTC credentials expire early, west of UTC they outlive their
 * issued lifetime.
 *
 * Those 30 columns arrived as a group, folded in from the OIDC and webhooks
 * module repos where nobody was watching the schema-wide convention. The next
 * fold is the exact scenario this test is for, which is why it asserts on the
 * SOURCE rather than on a snapshot: a snapshot is written by the same
 * `db:generate` that writes the schema and cannot contradict it.
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCHEMA_DIR = resolve(import.meta.dir, "../src/schema");

/**
 * Matches a `timestamp(...)` column builder whose options object is absent.
 * `timestamp("x", { withTimezone: true })` has a `,` before the `)` and is not
 * matched; `timestamp("x")` is. Deliberately source-level and deliberately
 * dumb — a parser here would be a second implementation of the thing under
 * test.
 */
const BARE_TIMESTAMP = /\btimestamp\(\s*"[^"]*"\s*\)/g;

describe("core schema timestamp columns", () => {
  it("declares no naive `timestamp` column", () => {
    const offenders: string[] = [];

    for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".ts"))) {
      const lines = readFileSync(resolve(SCHEMA_DIR, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(BARE_TIMESTAMP)) {
          offenders.push(`${file}:${i + 1}: ${m[0]}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("still finds the `timestamp` builder it is looking for", () => {
    // Negative control. If the import name, the builder call or the file
    // layout ever changes, the assertion above would pass vacuously by
    // matching nothing at all — this is the check that it has a subject.
    const all = readdirSync(SCHEMA_DIR)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(resolve(SCHEMA_DIR, f), "utf8"))
      .join("\n");

    expect(
      all.match(/\btimestamp\(\s*"[^"]*",\s*\{\s*withTimezone:\s*true\s*\}\s*\)/g)?.length ?? 0,
    ).toBeGreaterThan(100);
  });
});
