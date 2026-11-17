// SPDX-License-Identifier: Apache-2.0

import { sql, type SQL } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";

/** `database` is injected for tests that probe a second embedded database. */
export type PendingDatabase = { execute(query: SQL): PromiseLike<unknown> };

export interface PendingDataScript {
  /** Repo-relative path of the one-off script in `scripts/migration/` (`.ts` or `.sql`). */
  script: string;
  /** The drizzle migration whose application opened the window, e.g. `"0089"`. */
  after: string;
  /** Rows the script still has to fix on `database`; `0` once it has run (or never had to). */
  pending(database: PendingDatabase): Promise<number>;
  /** What is broken until the script runs. Shown to the operator verbatim. */
  consequence: string;
  /** The written condition under which this entry is deleted (§4). */
  removeWhen: string;
}

async function count(database: PendingDatabase, query: SQL): Promise<number> {
  const [row] = toRows<{ pending: number }>(await database.execute(query));
  return row?.pending ?? 0;
}

/**
 * Transitional boot refusals: one entry per one-off data script that has to run on every database
 * before the platform may serve from it.
 *
 * An entry exists ONLY while a script is pending somewhere. Deleting the entry (and its test case)
 * is the whole removal — `docs/NO_TRANSITIONAL_CODE.md` §4.
 *
 * There is deliberately no ledger table ("script N ran"): each `pending` predicate reads the data
 * the script fixes, so it discriminates a half-applied script, which a ledger row would not. The
 * predicates are EXACTLY the scripts' own `WHERE` on purpose, so the script always clears the
 * refusal it causes — a row it deliberately skips must not be counted here, or the boot could never
 * be cleared.
 *
 * Refusing rather than warning, for the reason `assertOAuthResourceColumnsPresent` does
 * (`schema-invariants.ts`): detection only, the repair is an operator task.
 */
export const PENDING_DATA_SCRIPTS: readonly PendingDataScript[] = [
  {
    script: "scripts/migration/0011-oauth-clients-self-service-fold.sql",
    after: "0057",
    // `pg_input_is_valid` included: a row whose `metadata` text is not JSON is one the fold
    // deliberately skips.
    pending: (database) =>
      count(
        database,
        sql`
      SELECT count(*)::int AS pending
      FROM oauth_clients
      WHERE self_service = false
        AND metadata IS NOT NULL
        AND pg_input_is_valid(metadata, 'jsonb')
        AND metadata::jsonb ->> 'selfService' = 'true'
    `,
      ),
    consequence:
      "Security control off: oauth clients carry the metadata key `selfService` while their " +
      "`self_service` column is still false (migration 0057 applied, the fold not). Until it runs, " +
      "/oauth2/token reads those self-registered (DCR/CIMD) clients as operator-provisioned and " +
      "stops confining their tokens to a single protected resource — each one may bind a token to " +
      "the whole platform audience and act across the REST API with the connecting user's full " +
      "authority.",
    removeWhen:
      "the PR that records `0011` as run: delete this entry, its test case and the README note.",
  },
  {
    script: "scripts/migration/0044-connection-shares.ts",
    after: "0089",
    // EXACTLY the `WHERE` with which `0044` empties the column: a target space it skips (deleted,
    // or of another organization) is emptied all the same. A fresh install never writes the column.
    pending: (database) =>
      count(
        database,
        sql`
      SELECT count(*)::int AS pending
      FROM integration_connections
      WHERE cardinality(shared_space_ids) > 0
    `,
      ),
    consequence:
      "Connection shares not copied: connections still hold space ids in " +
      "integration_connections.shared_space_ids (migration 0089 applied, `0044` not). Until it " +
      "runs, every one of those shares is invisible: the spaces they reach lose the connection, " +
      "and each schedule naming one is disabled at its next fire.",
    removeWhen:
      "the release that drops `integration_connections.shared_space_ids`: delete this entry and its test case.",
  },
  {
    script: "scripts/migration/0048-fold-package-shares.ts",
    after: "0100",
    pending: (database) =>
      count(database, sql`SELECT count(*)::int AS pending FROM package_shares`),
    consequence:
      "Package shares not folded: package_shares still holds rows (migration 0100 applied, `0048` " +
      "not). Until it runs, every package shared but never activated is gone from the space it was " +
      "shared with.",
    removeWhen: "the release that drops `package_shares`: delete this entry and its test case.",
  },
];

function commandFor(script: string, embeddedDataDir: string | null): string {
  if (script.endsWith(".sql")) return `apply ${script} to this database`;
  const run = `bun ${script}`;
  return embeddedDataDir === null
    ? `run \`${run}\` (dry run), then \`${run} --apply\`, with this DATABASE_URL`
    : `run \`PGLITE_DATA_DIR=${embeddedDataDir} ${run}\` (dry run), then the same with ` +
        "`--apply`, from the platform's directory while it is stopped (an embedded database " +
        "opens in one process at a time)";
}

/**
 * Refuse to boot while any one-off data script of {@link PENDING_DATA_SCRIPTS} is pending. Every
 * entry is evaluated, and ONE error lists them all, so an operator clears the whole window in one
 * pass rather than one crash-loop per script.
 *
 * A `.ts` script's command targets the database this process runs on: `DATABASE_URL`, or, on an
 * embedded database (`embeddedDataDir`), that directory named through `PGLITE_DATA_DIR`, which the
 * script requires so that a run with a forgotten `.env` never opens the default one.
 *
 * `scripts` and `database` are injected for tests — production reads the live database.
 */
export async function assertNoPendingDataScripts(
  embeddedDataDir: string | null,
  scripts: readonly PendingDataScript[] = PENDING_DATA_SCRIPTS,
  database: PendingDatabase = db,
): Promise<void> {
  const counts = await Promise.all(scripts.map((entry) => entry.pending(database)));
  const lines: string[] = [];
  scripts.forEach((entry, i) => {
    const pending = counts[i]!;
    if (pending === 0) return;
    lines.push(
      `- ${entry.script} (after drizzle ${entry.after}): ${pending} pending. ` +
        `${entry.consequence} To clear it: ${commandFor(entry.script, embeddedDataDir)}.`,
    );
  });
  if (lines.length === 0) return;

  throw new Error(
    `Pending one-off data script(s):\n${lines.join("\n")}\n` +
      "Refusing to boot until each script above has run: run them, then restart.",
  );
}
