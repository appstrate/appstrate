// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The platform's schema fingerprint (`scripts/schema-catalog.sql`) describes
 * what the core migration chain builds. This package's tables are migrated by
 * its own journal at init, so they must stay out of it, or every database with
 * the package loaded would read as drift.
 */

import { describe, it, expect } from "bun:test";
import { SQL } from "bun";
import { resolve } from "node:path";
import tables from "../tables.ts";

describe("schema catalog", () => {
  it("leaves this package's tables out", async () => {
    const query = await Bun.file(
      resolve(import.meta.dir, "../../../scripts/schema-catalog.sql"),
    ).text();
    const sql = new SQL(process.env.DATABASE_URL!);
    try {
      const present: { n: number }[] = await sql.unsafe(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN (${tables.map((t) => `'${t}'`).join(",")})`,
      );
      // The harness migrated them: otherwise this test would prove nothing.
      expect(present[0]!.n).toBe(tables.length);
      const lines: { line: string }[] = await sql.unsafe(query);
      expect(lines.length).toBeGreaterThan(0);
      for (const table of tables) {
        expect(lines.filter(({ line }) => line.includes(table))).toEqual([]);
      }
    } finally {
      await sql.close();
    }
  });
});
