// SPDX-License-Identifier: Apache-2.0

/**
 * The ids exposed as cursors (`run_logs.id`, `llm_usage.id`, `chat_messages.seq`)
 * and the pointers into them are int8, column AND sequence (migration 0069).
 * Each sequence is shared by every organization, so an int4 one caps the whole
 * platform at 2^31 - 1 rows. Asserted on a database the real chain built, not
 * on the Drizzle source, because production drifted from the source before
 * (#1507).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const CURSOR_COLUMNS = [
  "chat_messages.seq",
  "chat_sessions.last_assistant_seq",
  "chat_sessions.last_read_seq",
  "llm_usage.id",
  "run_logs.id",
];
const CURSOR_SEQUENCES = ["chat_messages_seq_seq", "llm_usage_id_seq", "run_logs_id_seq"];

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await migrate(drizzle(pg), { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
});

afterAll(async () => {
  await pg.close();
});

describe("cursor ids", () => {
  it("are bigint columns", async () => {
    const { rows } = await pg.query<{ col: string; data_type: string }>(
      `SELECT (table_name || '.' || column_name)::text AS col, data_type::text
       FROM information_schema.columns
       WHERE table_schema = 'public' AND (table_name || '.' || column_name)::text = ANY($1::text[])`,
      [CURSOR_COLUMNS],
    );
    expect(rows.sort((a, b) => a.col.localeCompare(b.col))).toEqual(
      CURSOR_COLUMNS.map((col) => ({ col, data_type: "bigint" })),
    );
  });

  it("are fed by bigint sequences that run past the int4 ceiling", async () => {
    const { rows } = await pg.query<{ sequence_name: string; data_type: string }>(
      `SELECT sequence_name::text, data_type::text FROM information_schema.sequences
       WHERE sequence_schema = 'public' AND sequence_name::text = ANY($1::text[])`,
      [CURSOR_SEQUENCES],
    );
    expect(rows.sort((a, b) => a.sequence_name.localeCompare(b.sequence_name))).toEqual(
      CURSOR_SEQUENCES.map((sequence_name) => ({ sequence_name, data_type: "bigint" })),
    );

    for (const seq of CURSOR_SEQUENCES) {
      const { rows: next } = await pg.query<{ v: string }>(
        `SELECT setval('${seq}', 2147483647), nextval('${seq}')::text AS v`,
      );
      expect(next[0]!.v).toBe("2147483648");
    }
  });
});
