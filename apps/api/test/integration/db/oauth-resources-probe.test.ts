// SPDX-License-Identifier: Apache-2.0

/**
 * The LIVE half of the boot drift check.
 *
 * `apps/api/test/unit/oauth-resources-drift.test.ts` covers the decision —
 * refuse, name the script, never repair — by injecting the predicate, so it
 * runs without a database and says nothing about the SQL. This covers the
 * default predicate: the `information_schema` query boot actually runs.
 *
 * That query is the entire input to a check that can take a deployment down,
 * and it is the one part of it a mock cannot exercise. A typo in the table or
 * column name would make it return no rows on a perfectly healthy database and
 * refuse every boot — the failure mode is total, and injection hides it.
 *
 * The tier-0 harness replays the migration chain, so `0006` has run and the
 * columns are present: calling with no argument must resolve. The absent case
 * stays in the unit test — dropping the column here would race every other
 * file, since `bun test` runs the suite in one process against one database.
 */

import { describe, it, expect } from "bun:test";
import { sql } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";
import { assertOAuthResourceColumnsPresent } from "../../../src/lib/boot.ts";

describe("assertOAuthResourceColumnsPresent — live information_schema probe", () => {
  it("resolves against a database the migration chain has been replayed on", async () => {
    expect(await assertOAuthResourceColumnsPresent()).toBeUndefined();
  });

  /**
   * Pins what the probe is allowed to assume. It reads ONE column as the
   * signature of `0006`; if that column ever moves or is renamed, this fails
   * here rather than by refusing every boot in production.
   */
  it("the column it probes for is really the one 0006 adds", async () => {
    const rows = toRows<{ table_name: string }>(
      await db.execute(sql`
        SELECT table_name
        FROM information_schema.columns
        WHERE column_name = 'resources'
          AND table_name IN ('oauth_access_tokens', 'oauth_consents', 'oauth_refresh_tokens')
        ORDER BY table_name
      `),
    );
    const names = rows.map((r) => r.table_name);

    expect(names).toEqual(["oauth_access_tokens", "oauth_consents", "oauth_refresh_tokens"]);
  });
});
