#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0055 — every chat session records the space it belonged to as a space it touched (#1886):
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0055-chat-sessions-touched-space.ts [--apply]
 *
 * A conversation belongs to the organization and its author, with no owning space: drizzle
 * `0107` drops `chat_sessions.space_id` and creates `chat_session_spaces`, the spaces a
 * conversation touched. A session of the previous release must come out of it touching its
 * former space, or it would be listed in no space and its author's other spaces' filters would
 * lose it. A migration carries no DML (`docs/NO_TRANSITIONAL_CODE.md` §2) and the column
 * disappears in the migration that creates the table, so the copy runs BEFORE the migrations,
 * on the previous release's schema, with the app stopped and `pg_dump` taken first:
 *
 *   1. this script, dry run, then `--apply`;
 *   2. the migrations (the release boot, or `bun packages/db/src/migrate.ts`).
 *
 * It creates `chat_session_spaces` when it is missing, with the exact definition of `0107` (whose
 * `CREATE … IF NOT EXISTS` then leaves it alone), and inserts one `(session_id, space_id)` row per
 * session still holding a space, stamped with the session's own `created_at`; a row already there
 * is kept. The migration carries a guard: it raises, and rolls the whole batch back, while a
 * session's space is not recorded, naming this script. A session created by the previous release
 * between this script and the migrations trips that guard: run the script again, then migrate.
 * Dry run by default (rolled back); `--apply` commits; a second `--apply` writes nothing. One
 * transaction. Targets `DATABASE_URL` or `PGLITE_DATA_DIR`, exits 2 with neither
 * (`lib/database-target.ts`); the platform applies the migrations itself at boot on the embedded
 * database, so stop it after a boot that fails on the guard, run the script there, and boot again.
 *
 * Once `0107` has run the column is gone and the script refuses: there is nothing left to read,
 * and no session can have been left unrecorded (the guard allowed the drop).
 *
 * Exit codes: 0, done (or dry-run); 1, refused or failed (nothing committed); 2, neither database
 * variable set.
 *
 * Rehearsal record (README rule 4): UNMEASURED on a production dump. Exercised on PGlite
 * (`scripts/test/0055-chat-sessions-touched-space.test.ts`), through `0107` itself.
 */

import { parseArgs } from "node:util";
import { getErrorMessage } from "@appstrate/core/errors";
import { describeDatabaseTarget, exitUnlessDatabaseNamed } from "./lib/database-target.ts";
import { table } from "./lib/report-table.ts";

class DryRunRollback extends Error {}

/** The statements `0107` runs first, identical: whoever creates the table, it is the same one. */
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS "chat_session_spaces" (
  "session_id" text NOT NULL,
  "space_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chat_session_spaces_session_id_space_id_pk" PRIMARY KEY("session_id","space_id"),
  CONSTRAINT "chat_session_spaces_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "chat_session_spaces_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action
)`;
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS "idx_chat_session_spaces_space" ON "chat_session_spaces" USING btree ("space_id")`;

/** Runs one statement of the script's transaction and returns its rows. */
export type Query = (statement: string) => Promise<Record<string, unknown>[]>;

export interface Counts {
  /** Sessions still holding a space. */
  sessions: number;
  /** Rows written into `chat_session_spaces`. */
  copied: number;
  /** After the copy: sessions whose space is not recorded (always 0 when it returns). */
  unrecorded: number;
}

/** Thrown when `chat_sessions.space_id` is already dropped. */
export class ColumnGone extends Error {
  constructor() {
    super(
      "chat_sessions.space_id no longer exists: migration 0107 already ran, and its guard let it " +
        "drop the column only once every session's space was recorded. Nothing to do.",
    );
  }
}

const count = async (query: Query, statement: string): Promise<number> =>
  Number((await query(statement))[0]!.n);

/** The copy, in the caller's transaction. */
export async function copySessionSpaces(query: Query): Promise<Counts> {
  const column = await count(
    query,
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'chat_sessions' AND column_name = 'space_id'`,
  );
  if (column === 0) throw new ColumnGone();
  await query(CREATE_TABLE);
  await query(CREATE_INDEX);
  const sessions = await count(
    query,
    `SELECT count(*)::int AS n FROM chat_sessions WHERE space_id IS NOT NULL`,
  );
  const copied = await count(
    query,
    `WITH copied AS (
       INSERT INTO chat_session_spaces (session_id, space_id, created_at)
       SELECT id, space_id, created_at FROM chat_sessions WHERE space_id IS NOT NULL
       ON CONFLICT DO NOTHING
       RETURNING 1
     ) SELECT count(*)::int AS n FROM copied`,
  );
  const unrecorded = await count(
    query,
    `SELECT count(*)::int AS n FROM chat_sessions s
     WHERE s.space_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM chat_session_spaces t WHERE t.session_id = s.id AND t.space_id = s.space_id)`,
  );
  if (unrecorded > 0) throw new Error(`${unrecorded} session(s) still unrecorded after the copy`);
  return { sessions, copied, unrecorded };
}

export async function runCopySessionSpaces(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<Counts> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  out(await describeDatabaseTarget());
  let counts: Counts | undefined;
  let committed = false;
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '300s'");
      counts = await copySessionSpaces(async (statement) =>
        toRows<Record<string, unknown>>(await tx.execute(statement)),
      );
      table(
        ["sessions with a space", "rows written", "left unrecorded"],
        [[String(counts.sessions), String(counts.copied), String(counts.unrecorded)]],
      ).forEach(out);
      if (!apply) throw new DryRunRollback();
    });
    committed = true;
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  out(
    committed
      ? "0055: APPLIED — committed. Run the migrations next."
      : "0055: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.",
  );
  return counts!;
}

if (import.meta.main) {
  exitUnlessDatabaseNamed();
  let code = 0;
  let closeDb: (() => Promise<void>) | undefined;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean" } },
      strict: true,
    });
    const apply = values.apply === true;
    ({ closeDb } = await import("@appstrate/db/client"));
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`0055 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runCopySessionSpaces({ apply, out });
  } catch (error) {
    code = 1;
    process.stdout.write(`0055: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
