// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { MODEL_ERROR_CATEGORIES } from "@appstrate/core/model-error";
import { db, toRows } from "../src/client.ts";

// PostgreSQL normalizes IN to ANY(array). Compare the accepted literals, so changes to
// either the runtime classifier or the migrated CHECK require updating the other.
it("persists every category the runtime reports and rejects unrecognized categories", async () => {
  const rows = toRows<{ category: string }>(
    await db.execute(`
    SELECT (regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''', 'g'))[1] AS category
    FROM pg_constraint
    WHERE conrelid = 'public.runs'::regclass AND conname = 'runs_model_error_category_valid'
  `),
  );
  expect(rows.map(({ category }) => category).sort()).toEqual([...MODEL_ERROR_CATEGORIES].sort());
});
