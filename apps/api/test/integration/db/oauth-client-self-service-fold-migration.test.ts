// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0010-oauth-clients-self-service-fold.sql` against seeded rows.
 *
 * `0057_oauth_provider_1_7_3` adds `oauth_clients.self_service` and lands it
 * `false` on every row; `metadata` survives that file, so the fold is this
 * script's (`docs/NO_TRANSITIONAL_CODE.md` §2). Until it runs, a self-registered
 * client reads as operator-provisioned and `/oauth2/token` stops confining its
 * tokens to one protected resource (`modules/oidc/auth/guards.ts`) — so the
 * script is the whole mechanism, and an empty one would pass any assertion made
 * against a database with no self-service client in it.
 *
 * Two rows carry the point. One holds the JSON key the fold reads. The other
 * holds `metadata` that is not JSON at all: the column is `text` and the
 * provider persists what an RFC 7591 registration body presented, so a bare
 * `metadata::jsonb` aborts on that row and takes the first row's repair with
 * it. `pg_input_is_valid` is what keeps them independent, and both backends
 * this suite runs on have it — PostgreSQL 16.8 (`docker-compose.yml`) and the
 * tier-0 PGlite build (`@electric-sql/pglite` ^0.5.4).
 *
 * Seeds with raw SQL and cleans up by `client_id`: `oauth_clients` is not in
 * `truncateAll()`'s list (the boot-seeded CLI client lives there), and the
 * pre-fold state — `self_service = false` beside a `metadata` that says
 * otherwise — is one no writer in the platform produces.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, toRows, getPGliteClient, reservePgConnection } from "@appstrate/db/client";

const SCRIPT = new URL(
  "../../../../../scripts/migration/0010-oauth-clients-self-service-fold.sql",
  import.meta.url,
).pathname;

const FOLDED = "cli_0010_selfservice";
const UNPARSEABLE = "cli_0010_unparseable";
const UNPARSEABLE_METADATA = "not json";

/**
 * Run a multi-statement script through the raw driver. `db.execute` speaks the
 * extended protocol (one statement per call) and the script is a
 * `BEGIN … COMMIT` block. Same helper, same reasoning, as
 * `org-viewer-to-guest-migration.test.ts`.
 */
async function execScript(source: string): Promise<void> {
  const pglite = getPGliteClient();
  if (pglite) {
    try {
      await pglite.exec(source);
    } catch (error) {
      await endAbortedTransaction((s) => pglite.exec(s));
      throw error;
    }
    return;
  }
  const conn = await reservePgConnection();
  if (!conn) throw new Error("no raw database connection available");
  try {
    await conn.sql.unsafe(source);
  } catch (error) {
    await endAbortedTransaction((s) => conn.sql.unsafe(s));
    throw error;
  } finally {
    conn.release();
  }
}

/**
 * Both backends abandon a multi-statement script at the first error and never
 * reach its `COMMIT`, leaving the session in an open, aborted transaction that
 * `25P02`s every later query in the process.
 */
async function endAbortedTransaction(exec: (s: string) => Promise<unknown>): Promise<void> {
  try {
    await exec("ROLLBACK");
  } catch {
    /* nothing to roll back */
  }
}

async function seed(): Promise<void> {
  await execScript(`
    INSERT INTO oauth_clients (id, client_id, name, redirect_uris, level, self_service, metadata)
    VALUES
      ('${FOLDED}', '${FOLDED}', 'Self-registered', ARRAY['https://example.test/cb'],
       'instance', false, '{"selfService":true,"level":"instance"}'),
      ('${UNPARSEABLE}', '${UNPARSEABLE}', 'Metadata that is not JSON',
       ARRAY['https://example.test/cb'], 'instance', false, '${UNPARSEABLE_METADATA}');
  `);
}

async function removeSeed(): Promise<void> {
  await db.execute(sql`DELETE FROM oauth_clients WHERE client_id IN (${FOLDED}, ${UNPARSEABLE})`);
}

async function clientRow(clientId: string): Promise<{ self_service: boolean; metadata: string }> {
  const rows = toRows<{ self_service: boolean; metadata: string }>(
    await db.execute(
      sql`SELECT self_service, metadata FROM oauth_clients WHERE client_id = ${clientId}`,
    ),
  );
  return rows[0]!;
}

describe("scripts/migration/0010 — `self_service` folded out of the metadata JSON", () => {
  beforeEach(async () => {
    await removeSeed();
    await seed();
  });

  afterEach(async () => {
    await removeSeed();
  });

  it("flips the row the JSON key names, and leaves the unparseable one alone", async () => {
    // Before: the state the script exists for — the JSON says self-service,
    // the column does not.
    expect((await clientRow(FOLDED)).self_service).toBe(false);
    expect((await clientRow(UNPARSEABLE)).self_service).toBe(false);

    // The unparseable row is in the same table, so a statement that cast every
    // `metadata` would reject here rather than fold anything.
    await execScript(await Bun.file(SCRIPT).text());

    expect((await clientRow(FOLDED)).self_service).toBe(true);

    const untouched = await clientRow(UNPARSEABLE);
    expect(untouched.self_service).toBe(false);
    expect(untouched.metadata).toBe(UNPARSEABLE_METADATA);
  });

  it("is idempotent — a second run matches zero rows and changes nothing", async () => {
    const source = await Bun.file(SCRIPT).text();
    await execScript(source);
    await execScript(source);

    expect((await clientRow(FOLDED)).self_service).toBe(true);
    expect((await clientRow(UNPARSEABLE)).self_service).toBe(false);
  });
});
