// SPDX-License-Identifier: Apache-2.0

/**
 * Fault injection for `run_logs` writes: a `BEFORE INSERT` trigger makes every
 * INSERT whose `message` equals a marker fail with a chosen SQLSTATE. The
 * failure is a genuine Postgres error travelling through Drizzle, so callers
 * exercise the real error-classification path — a transient code
 * (`40001`, `08006`) must roll back, a row-value code (`22xxx`, `23514`) is
 * dropped with a placeholder row. Works under PGlite (tier 0) and Postgres.
 *
 * Always pair with {@link clearRunLogsFault} in a `finally`/`afterEach`: the
 * trigger lives on the shared test database and would poison later tests.
 */

import { sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";

const NAME = "_test_run_logs_fault";

export async function failRunLogsInsert(message: string, sqlState: string): Promise<void> {
  if (!/^[0-9A-Z]{5}$/.test(sqlState)) throw new Error(`not a SQLSTATE: ${sqlState}`);
  const literal = message.replaceAll("'", "''");
  await db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION ${NAME}() RETURNS trigger AS $$
      BEGIN
        IF NEW.message = '${literal}' THEN
          RAISE EXCEPTION 'injected run_logs fault' USING ERRCODE = '${sqlState}';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
  );
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${NAME} ON run_logs`));
  await db.execute(
    sql.raw(`CREATE TRIGGER ${NAME} BEFORE INSERT ON run_logs
      FOR EACH ROW EXECUTE FUNCTION ${NAME}()`),
  );
}

/** Idempotent: safe to call when no fault is installed. */
export async function clearRunLogsFault(): Promise<void> {
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${NAME} ON run_logs`));
  await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${NAME}()`));
}
