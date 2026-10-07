// SPDX-License-Identifier: Apache-2.0

/**
 * The CHECKs bounding a `connection_ids` array spell `MAX_CONNECTIONS_PER_INTEGRATION` as a
 * literal (drizzle-kit cannot read a constant), so the two can drift apart: read the bound off the
 * migrated catalog and hold it to the constant.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { journalPGlite } from "../helpers/journal.ts";

let pg: PGlite;

beforeAll(async () => {
  pg = await journalPGlite();
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("connection_ids cardinality CHECKs", () => {
  it("bound the array at MAX_CONNECTIONS_PER_INTEGRATION", async () => {
    const { rows } = await pg.query<{ relation: string; definition: string }>(
      `SELECT c.conrelid::regclass::text AS relation, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
        WHERE c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%cardinality(connection_ids)%'`,
    );
    const bounds = Object.fromEntries(
      rows.map((row) => [
        row.relation,
        Number(/cardinality\(connection_ids\) <= (\d+)/.exec(row.definition)?.[1]),
      ]),
    );

    expect(Object.keys(bounds)).toEqual(
      expect.arrayContaining(["integration_pins", "integration_org_defaults"]),
    );
    for (const bound of Object.values(bounds)) {
      expect(bound).toBe(MAX_CONNECTIONS_PER_INTEGRATION);
    }
  });
});
