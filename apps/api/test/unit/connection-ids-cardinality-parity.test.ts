// SPDX-License-Identifier: Apache-2.0

/**
 * The CHECKs bounding a `connection_ids` array spell their bounds as literals (drizzle-kit cannot
 * read a constant), so they can drift from `MAX_CONNECTIONS_PER_INTEGRATION` and from the write
 * schemas: read the bounds off the migrated catalog and hold them to both.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import {
  connectionIdSetSchema,
  nonEmptyConnectionIdSetSchema,
} from "../../src/lib/connection-set.ts";
import { journalPGlite } from "../helpers/journal.ts";

let pg: PGlite;

beforeAll(async () => {
  pg = await journalPGlite();
}, 300_000);

afterAll(async () => {
  await pg.close();
});

function minItemsOf(schema: z.ZodType): number {
  const json = z.toJSONSchema(schema, { io: "input" }) as { minItems?: number };
  return json.minItems ?? 0;
}

describe("connection_ids cardinality CHECKs", () => {
  it("bound each array as its write schema does, up to MAX_CONNECTIONS_PER_INTEGRATION", async () => {
    const { rows } = await pg.query<{ relation: string; definition: string }>(
      `SELECT c.conrelid::regclass::text AS relation, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
        WHERE c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%cardinality(connection_ids)%'`,
    );
    const bounds = Object.fromEntries(
      rows.map((row) => [
        row.relation,
        {
          min: Number(/cardinality\(connection_ids\) >= (\d+)/.exec(row.definition)?.[1]),
          max: Number(/cardinality\(connection_ids\) <= (\d+)/.exec(row.definition)?.[1]),
        },
      ]),
    );

    expect(bounds).toEqual({
      integration_pins: {
        min: minItemsOf(connectionIdSetSchema),
        max: MAX_CONNECTIONS_PER_INTEGRATION,
      },
      integration_org_defaults: {
        min: minItemsOf(nonEmptyConnectionIdSetSchema),
        max: MAX_CONNECTIONS_PER_INTEGRATION,
      },
    });
    expect(bounds.integration_pins?.min).toBe(0);
    expect(bounds.integration_org_defaults?.min).toBe(1);
  });
});
