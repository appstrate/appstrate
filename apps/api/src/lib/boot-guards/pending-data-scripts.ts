// SPDX-License-Identifier: Apache-2.0

import { sql, type SQL } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";
import { decryptCredentials } from "@appstrate/connect";

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
 * Transitional boot refusals: one entry per one-off data script that must run before the
 * platform serves. Deleting an entry and its test case is the whole removal
 * (`docs/NO_TRANSITIONAL_CODE.md` §4).
 *
 * No ledger table: each `pending` predicate reads the data the script fixes, with EXACTLY the
 * script's own `WHERE`, so a half-applied script is caught and the script always clears the
 * refusal it causes.
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
  {
    script: "scripts/migration/0058-model-credential-needs-reconnection-mirror.ts",
    after: "0114",
    // EXACTLY `0058`'s scan: an unflagged model credential whose blob still says flagged. A blob
    // that cannot be decrypted is not counted, as `0058` leaves it alone. The column is the only
    // authority on a model credential's death, so until this runs such a credential reads as alive.
    pending: async (database) => {
      const rows = toRows<{ blob: string }>(
        await database.execute(
          sql`SELECT credentials_encrypted AS blob FROM model_provider_credentials WHERE needs_reconnection = false`,
        ),
      );
      let pending = 0;
      for (const { blob } of rows) {
        try {
          if (decryptCredentials<{ needsReconnection?: boolean }>(blob).needsReconnection === true)
            pending++;
        } catch {
          // Unreadable: `0058` lists it and leaves it alone.
        }
      }
      return pending;
    },
    consequence:
      "Model credentials flagged dead only inside their encrypted blob (migration 0114 added the " +
      "column defaulting to false, `0058` not run). The column is the only authority on a model credential's death, " +
      "so until it runs those credentials read as alive and are used again.",
    removeWhen:
      "the release after the one that makes the column the only authority: delete this entry and its test case.",
  },
  {
    script: "scripts/migration/0059-personal-space-audience.ts",
    after: "0117",
    // EXACTLY what `0059` fixes: an organization package's row in a personal space outside its
    // home that no offer to that organization keeps (none, or a row that is not a decision about
    // it), plus the notifications of the retired kind.
    pending: (database) =>
      count(
        database,
        sql`
      SELECT (
        SELECT count(*) FROM space_packages sp
          JOIN spaces s ON s.id = sp.space_id AND s.owner_user_id IS NOT NULL
          JOIN packages p ON p.id = sp.package_id
          WHERE p.org_id IS NOT NULL
            AND p.org_id = s.org_id
            AND sp.space_id IS DISTINCT FROM p.home_space_id
            AND (sp.placed_by_offer = false OR NOT EXISTS (SELECT 1 FROM org_package_offers o
              WHERE o.org_id = s.org_id AND o.package_id = p.id))
      )::int + (SELECT count(*) FROM notifications WHERE type = 'package_shared')::int AS pending
    `,
      ),
    consequence:
      "Personal spaces still run packages the organization never offered (shares and integrations " +
      "switched on under the previous rule) and notifications of a retired kind remain (migration " +
      "0117 applied, `0059` not). The API refuses to switch such packages on again, so they must " +
      "be brought under the rule first.",
    removeWhen:
      "the release after the one that ships `0059`: delete this entry, its test case and the README note, " +
      "and add the drizzle migration that validates `notifications_type_valid` (a fresh install never ran `0059`).",
  },
  {
    script: "scripts/migration/0060-personal-space-preset-role.ts",
    after: "0118",
    // EXACTLY `0060`'s `WHERE`: a row still holding the retired document key.
    pending: (database) =>
      count(
        database,
        sql`SELECT count(*)::int AS pending FROM organizations WHERE org_settings ? 'personal_space_role'`,
      ),
    consequence:
      "Personal-space default roles not moved: organizations still hold `personal_space_role` in " +
      "org_settings (migration 0118 applied, `0060` not). Until it runs, every preset default below " +
      "`admin` is ignored and their members get `admin` in their personal space.",
    removeWhen: "the release after the one that ships `0060`: delete this entry and its test case.",
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
 * Refuse to boot while any entry of {@link PENDING_DATA_SCRIPTS} is pending. ONE error lists
 * them all, so an operator clears the window in one pass. The command it prints targets this
 * process's database (`DATABASE_URL`, or `PGLITE_DATA_DIR` when `embeddedDataDir` is set).
 * `scripts` and `database` are injected for tests.
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
