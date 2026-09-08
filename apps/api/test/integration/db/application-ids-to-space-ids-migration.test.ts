// SPDX-License-Identifier: Apache-2.0

/**
 * Operator script `scripts/migration/0003-application-ids-to-space-ids.sql` —
 * the DATA half of the `application` → `space` rename.
 *
 * Why it needs a test at all. The drizzle chain (including
 * `0053_applications_to_spaces`) is replayed at boot by the tier-0 harness, so
 * a SYNTACTICALLY broken migration already fails every integration test. This
 * script is not in that chain — it is never replayed anywhere — and even if it
 * were, a replay against an empty database cannot tell a `WHERE` clause that
 * never matches from one that matches everything.
 *
 * Why the assertions are shaped the way they are. `0001`'s header records the
 * incident this whole family of scripts is written against: a rewrite produced
 * a value that was NEITHER the old form nor the new one, and the shipped
 * verification returned 0 for both outcomes, so it reported success either way.
 * Every rewrite below is therefore asserted on BOTH halves — the legacy form is
 * gone AND the new form is exactly what it should be — and every anchored
 * rewrite carries a NEGATIVE CONTROL: a value that looks like it should match
 * and must come through byte-identical.
 *
 * Self-contained on purpose. It does not use `createTestContext` or
 * `truncateAll`. Every fixture here is PRE-rename by definition — `app_` ids,
 * `level = 'application'`, `end_user:app_…` realms — and the helpers can no
 * longer produce any of it: `createTestContext` mints `prefixedId("spc")` and
 * asserts it against `SPACE_ID_RE`, which rejects the `app_` shape this script
 * exists to rewrite. So it seeds and tears down its own fixed ids with raw SQL
 * — which is also what the operator runs, so the test exercises the same
 * surface. `truncateAll` would work now; it is still not used, because a fixed
 * id set that only this file writes is what makes the CLEANUP below exact.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { db, toRows, getPGliteClient, reservePgConnection } from "@appstrate/db/client";
import { SPACE_ID_RE } from "../../../src/lib/ids.ts";

const SCRIPT = new URL(
  "../../../../../scripts/migration/0003-application-ids-to-space-ids.sql",
  import.meta.url,
).pathname;

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Canonical `prefixedId("app")` shapes: `app_` + a lowercase dashed UUID. The
// script must turn each into the `spc_` id with the SAME UUID.
const ORG = "e0000000-0000-4000-8000-00000000d003";
const APP_A = "app_1a1a1a1a-1111-4111-8111-111111111111";
const APP_B = "app_2b2b2b2b-2222-4222-8222-222222222222";
const SPC_A = "spc_1a1a1a1a-1111-4111-8111-111111111111";
const SPC_B = "spc_2b2b2b2b-2222-4222-8222-222222222222";

/**
 * Run a multi-statement SQL script. `db.execute` speaks the extended protocol
 * (one statement per call) and the script is a `BEGIN … COMMIT` block full of
 * `DO $$ … $$` bodies, so it goes to the raw driver: PGlite's `exec()` in
 * tier 0, a reserved postgres.js connection's parameterless `unsafe()` (simple
 * protocol) in tier 3.
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
 * Clear an aborted transaction left behind by a failed script.
 *
 * Both backends abandon a multi-statement script at the FIRST error and never
 * reach the statements after it — including the trailing `COMMIT`. A script that
 * opens its own transaction (the operator script does, and so does anything
 * fixture-shaped that borrows the idiom) therefore leaves the session inside an
 * OPEN, ABORTED transaction. Every subsequent statement on it fails with
 * `25P02 current transaction is aborted`, which in tier 0 is the single shared
 * PGlite session and in tier 3 is a pooled connection handed straight to the
 * next caller.
 *
 * That turns one broken script into a cascade of unrelated failures across the
 * rest of the process — and, worse, would take this file's own catalog restore
 * down with it, which is the one thing that must never fail. `ROLLBACK` outside
 * a transaction is a no-op warning, so this is safe on the paths where the
 * script never opened one.
 */
async function endAbortedTransaction(exec: (sql: string) => Promise<unknown>): Promise<void> {
  try {
    await exec("ROLLBACK");
  } catch {
    /* nothing to roll back */
  }
}

async function replayScript(): Promise<void> {
  await execScript(await Bun.file(SCRIPT).text());
}

/**
 * Restore the catalog no matter what the body did.
 *
 * This file is the only one in `test/integration/db/` that mutates the shared
 * CATALOG rather than just rows — `legacy-permission-scope-migration` and
 * `finish-file-rename-migration`, the precedents, are pure DML over
 * `truncateAll()`. Catalog residue does not stop at the file boundary: the whole
 * suite runs in ONE Bun process against ONE database, so anything left behind
 * here is the baseline every later file sees.
 *
 * The dangerous shape is the setup below, which must DROP the three `level`
 * CHECKs to insert pre-rename fixtures and then put them back. Run as a plain
 * sequence, a failure anywhere between the two — a seed that collides, a fixture
 * that trips a different constraint — leaves `webhooks` and `oauth_clients` with
 * no `level` CHECK at all for the rest of the process. Nothing fails at that
 * point: later files write only legal values, so the missing constraints are
 * invisible and simply stop being enforced.
 *
 * `finally` closes that. Wrapping the pair in a SQL transaction does not: both
 * backends abandon a multi-statement script at the first error, so the trailing
 * `COMMIT` is never reached and the connection is left in an aborted
 * transaction (`25P02`) that poisons every query after it.
 */
async function withCatalogRestored(body: () => Promise<void>, restore: string): Promise<void> {
  try {
    await body();
  } finally {
    await execScript(restore);
  }
}

async function rows<T = Record<string, unknown>>(query: string): Promise<T[]> {
  return toRows<T>(await db.execute(sql.raw(query)));
}

async function one<T = Record<string, unknown>>(query: string): Promise<T> {
  const result = await rows<T>(query);
  return result[0]!;
}

// ─── Seed / teardown ─────────────────────────────────────────────────────────

/**
 * The three `level` CHECKs are `NOT VALID` after `0053`, which skips only the
 * initial full-table scan — they still REJECT a new row spelling
 * `level = 'application'`. Dropping them for the insert and putting them back
 * exactly as `0053` left them is not a workaround: it reproduces the state a
 * production database is actually in when the operator runs this script.
 */
const DROP_LEVEL_CHECKS = `
  ALTER TABLE webhooks DROP CONSTRAINT IF EXISTS webhooks_level_values;
  ALTER TABLE webhooks DROP CONSTRAINT IF EXISTS webhooks_level_check;
  ALTER TABLE oauth_clients DROP CONSTRAINT IF EXISTS oauth_clients_level_check;
`;

const READD_LEVEL_CHECKS_NOT_VALID = `
  ALTER TABLE webhooks ADD CONSTRAINT webhooks_level_values
    CHECK (level IN ('org', 'space')) NOT VALID;
  ALTER TABLE webhooks ADD CONSTRAINT webhooks_level_check
    CHECK ((level = 'org' AND space_id IS NULL)
        OR (level = 'space' AND space_id IS NOT NULL)) NOT VALID;
  ALTER TABLE oauth_clients ADD CONSTRAINT oauth_clients_level_check
    CHECK ((level = 'org' AND referenced_org_id IS NOT NULL AND referenced_space_id IS NULL)
        OR (level = 'space' AND referenced_space_id IS NOT NULL AND referenced_org_id IS NULL)
        OR (level = 'instance' AND referenced_org_id IS NULL AND referenced_space_id IS NULL))
    NOT VALID;
`;

/**
 * A stand-in for the two NOTIFY triggers the script disables in step 2 and
 * re-enables in step 6.
 *
 * Those two triggers are NOT in this database. `createNotifyTriggers()` is
 * called from exactly one place — `bootBackground()` in `apps/api/src/lib/
 * boot.ts` — and the test harness never boots the API, so every `DISABLE` /
 * `ENABLE` the script aims at them is a guarded no-op here. Deleting steps 2
 * and 6 from the script outright therefore changed no test outcome: the whole
 * fan-out suppression they exist for was untested.
 *
 * So install triggers under THE SAME NAMES, on the same tables, with the same
 * firing conditions, bound to a function that records instead of notifying. The
 * script disables by name, so it acts on these exactly as it would on the real
 * ones, and the recording table answers the question `pg_notify` cannot be asked
 * from here: did the trigger fire while the id rewrite was running?
 *
 * Nothing real is replaced — `notify_run_change()` and
 * `notify_integration_connection_change()` are untouched, and the probe is
 * installed and dropped inside one test.
 *
 * `runs_notify_update_trigger`'s WHEN clause is copied verbatim from
 * `createNotifyTriggers()` rather than reduced to the one column the script
 * writes: a guard that fires more narrowly than the real one would turn a real
 * notification storm into a silent pass.
 */
const PROBE_INSTALL = `
  CREATE TABLE _m0003_notify_probe (tgname text NOT NULL, op text NOT NULL);
  CREATE FUNCTION _m0003_notify_probe_fn() RETURNS TRIGGER AS $fn$
  BEGIN
    INSERT INTO _m0003_notify_probe VALUES (TG_NAME, TG_OP);
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END;
  $fn$ LANGUAGE plpgsql;
  CREATE TRIGGER runs_notify_update_trigger
    AFTER UPDATE ON runs
    FOR EACH ROW
    WHEN (
      OLD.id IS DISTINCT FROM NEW.id
      OR OLD.package_id IS DISTINCT FROM NEW.package_id
      OR OLD.status IS DISTINCT FROM NEW.status
      OR OLD.user_id IS DISTINCT FROM NEW.user_id
      OR OLD.end_user_id IS DISTINCT FROM NEW.end_user_id
      OR OLD.org_id IS DISTINCT FROM NEW.org_id
      OR OLD.space_id IS DISTINCT FROM NEW.space_id
      OR OLD.schedule_id IS DISTINCT FROM NEW.schedule_id
      OR OLD.error IS DISTINCT FROM NEW.error
      OR OLD.started_at IS DISTINCT FROM NEW.started_at
      OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
      OR OLD.duration IS DISTINCT FROM NEW.duration
    )
    EXECUTE FUNCTION _m0003_notify_probe_fn();
  CREATE TRIGGER integration_connections_notify_trigger
    AFTER INSERT OR UPDATE OR DELETE ON integration_connections
    FOR EACH ROW EXECUTE FUNCTION _m0003_notify_probe_fn();
`;

const PROBE_DROP = `
  DROP TRIGGER IF EXISTS runs_notify_update_trigger ON runs;
  DROP TRIGGER IF EXISTS integration_connections_notify_trigger ON integration_connections;
  DROP FUNCTION IF EXISTS _m0003_notify_probe_fn();
  DROP TABLE IF EXISTS _m0003_notify_probe;
`;

/** The names `createNotifyTriggers()` owns. See PROBE_INSTALL. */
const NOTIFY_TRIGGER_NAMES = [
  "runs_notify_insert_trigger",
  "runs_notify_update_trigger",
  "run_logs_notify_trigger",
  "integration_connections_notify_trigger",
];

const CLEANUP = `
  DELETE FROM device_codes WHERE id LIKE 'dc_m0003%';
  DELETE FROM oauth_clients WHERE client_id LIKE 'cli_m0003%';
  DELETE FROM storage_deletion_jobs WHERE id LIKE 'sdj_m0003%';
  DELETE FROM audit_events WHERE org_id = '${ORG}';
  DELETE FROM runs WHERE id LIKE 'run_m0003%';
  DELETE FROM integration_connections WHERE account_id LIKE 'acct_m0003%';
  DELETE FROM packages WHERE id = '@m0003/agent';
  DELETE FROM organizations WHERE id = '${ORG}';
  DELETE FROM "session" WHERE id LIKE 'sess_m0003%';
  DELETE FROM "user" WHERE id LIKE 'u_m0003%';
`;

const SEED = `
  INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at, realm) VALUES
    ('u_m0003_platform', 'P', 'p.m0003@x.test', true, now(), now(), 'platform'),
    ('u_m0003_end',      'E', 'e.m0003@x.test', true, now(), now(), 'end_user:${APP_A}'),
    -- NEGATIVE CONTROL for the LIKE-escape. The anchor is
    -- \`LIKE 'end\\_user:app\\_%'\`; drop either backslash and \`_\` becomes LIKE's
    -- single-character wildcard, which matches this sentinel.
    ('u_m0003_sentinel', 'S', 's.m0003@x.test', true, now(), now(), 'endXuser:appXsentinel');

  INSERT INTO "session" (id, expires_at, token, created_at, updated_at, user_id, realm) VALUES
    ('sess_m0003_end',  now() + interval '1 day', 'tok_m0003_a', now(), now(), 'u_m0003_end',      'end_user:${APP_A}'),
    ('sess_m0003_plat', now() + interval '1 day', 'tok_m0003_b', now(), now(), 'u_m0003_platform', 'platform');

  INSERT INTO organizations (id, name, slug, created_by)
  VALUES ('${ORG}', 'M0003 Org', 'm0003-org', 'u_m0003_platform');

  INSERT INTO spaces (id, org_id, name, is_default, created_by) VALUES
    ('${APP_A}', '${ORG}', 'Default', true,  'u_m0003_platform'),
    ('${APP_B}', '${ORG}', 'Second',  false, 'u_m0003_platform');

  INSERT INTO api_keys (id, org_id, space_id, name, key_hash, key_prefix, scopes) VALUES
    ('e0000000-0000-4000-8000-0000000000a1', '${ORG}', '${APP_A}', 'k1', 'h_m0003_1', 'ask_m0003a',
     -- Two anchored values, plus three NEGATIVE CONTROLS: an unrelated Appstrate
     -- scope, a token that merely CONTAINS the word, and \`workspaces:read\` — a
     -- real third-party value shipped by the Monday/Typeform integrations, which
     -- any \`spaces:\`-anchored pass would corrupt.
     ARRAY['applications:read', 'applications:write', 'runs:read', 'myapplications:read', 'workspaces:read']),
    ('e0000000-0000-4000-8000-0000000000a2', '${ORG}', '${APP_B}', 'k2', 'h_m0003_2', 'ask_m0003b',
     ARRAY['spaces:read']);

  INSERT INTO end_users (id, space_id, org_id, email)
  VALUES ('eu_m0003', '${APP_A}', '${ORG}', 'eu.m0003@x.test');

  -- runs and integration_connections are seeded for TWO reasons, both of
  -- them about making an assertion mean something.
  --
  -- 1. The survivor sweep below iterates all eighteen columns that reference
  --    spaces, but a column with no row trivially reports zero app_
  --    survivors BEFORE the script has done anything. Only the seven tables
  --    seeded above carried rows, so eleven of the eighteen were passing
  --    vacuously. These two close the two that matter most: runs is the
  --    largest table the rewrite touches in production, and
  --    integration_connections is the other table whose NOTIFY trigger the
  --    script disables.
  -- 2. Steps 2 and 6 of the script disable and re-enable exactly those two
  --    triggers so the id rewrite does not queue one pg_notify per historical
  --    row. With no row on either table there was nothing for those steps to
  --    suppress, so deleting both from the script changed no test outcome. The
  --    trigger test below now watches them fire.
  INSERT INTO packages (id, org_id, type, created_by)
  VALUES ('@m0003/agent', '${ORG}', 'agent', 'u_m0003_platform');

  INSERT INTO runs (id, org_id, space_id, package_id, user_id, status)
  VALUES ('run_m0003_a', '${ORG}', '${APP_A}', '@m0003/agent', 'u_m0003_platform', 'success');

  INSERT INTO integration_connections
    (integration_package_id, auth_key, account_id, space_id, user_id, credentials_encrypted)
  VALUES ('@m0003/agent', 'primary', 'acct_m0003', '${APP_A}', 'u_m0003_platform', 'enc_m0003');

  INSERT INTO audit_events (org_id, space_id, actor_type, actor_id, action, resource_type, resource_id)
  VALUES ('${ORG}', '${APP_A}', 'user', 'u_m0003_platform', 'application.created', 'application', '${APP_A}');

  INSERT INTO files (id, org_id, space_id, purpose, storage_key, name, mime, size, sha256) VALUES
    ('file_m0003_a', '${ORG}', '${APP_A}', 'agent_output',
     'files/${APP_A}/file_m0003_a/report.html', 'report.html', 'text/html', 1, 'x'),
    -- A FILENAME carrying the retired prefix, alongside a space segment that
    -- also carries it: no part of either is rewritten.
    ('file_m0003_b', '${ORG}', '${APP_B}', 'agent_output',
     'files/${APP_B}/file_m0003_b/app_notes.md', 'app_notes.md', 'text/markdown', 1, 'y');

  INSERT INTO uploads (id, org_id, space_id, storage_key, name, mime, size, expires_at)
  VALUES ('upl_m0003_a', '${ORG}', '${APP_A}', 'uploads/${APP_A}/upl_m0003_a/a.txt',
          'a.txt', 'text/plain', 1, now() + interval '1 hour');

  INSERT INTO storage_deletion_jobs (id, bucket, storage_key, reason) VALUES
    ('sdj_m0003_1', 'files',        '${APP_A}/file_m0003_a/report.html', 'application_deleted'),
    ('sdj_m0003_2', 'uploads',      '${APP_A}/upl_m0003_a/a.txt',        'upload_expired'),
    -- A RUN-workspace key whose segment 1 is a run id that looks exactly like
    -- a space id.
    ('sdj_m0003_3', 'run-workspace', 'app_lookalike_run/files/brief.pdf', 'run_workspace_deleted'),
    -- An owner namespace in a third bucket.
    ('sdj_m0003_4', 'agent-packages', 'app_owner/pkg/1.0.0.afps',         'version_deleted'),
    -- A LIKE 'app_%' escape lookalike, in a bucket a rewrite would target.
    ('sdj_m0003_5', 'files',        'appXsentinel/file_x/a.txt',          'file_deleted');

  INSERT INTO webhooks (id, org_id, space_id, level, url, events, secret) VALUES
    ('wh_m0003_app', '${ORG}', '${APP_A}', 'application', 'https://a.m0003.test', ARRAY['run.success'], 's'),
    ('wh_m0003_org', '${ORG}', NULL,       'org',         'https://b.m0003.test', ARRAY['run.success'], 's');

  INSERT INTO oauth_clients (id, client_id, name, level, referenced_space_id, scopes, redirect_uris, type, disabled) VALUES
    ('oc_m0003_a', 'cli_m0003_app',  'A', 'application', '${APP_A}',
     ARRAY['applications:read', 'openid', 'myapplications:read'], ARRAY['https://a.m0003.test/cb'], 'web', false),
    ('oc_m0003_i', 'cli_m0003_inst', 'I', 'instance',    NULL,
     ARRAY['openid'], ARRAY['https://b.m0003.test/cb'], 'web', false);

  INSERT INTO device_codes (id, client_id, user_code, device_code, scope, status, expires_at, last_polled_at, polling_interval) VALUES
    ('dc_m0003_1', 'cli_m0003_inst', 'UCM31', 'DCM31',
     'applications:read myapplications:read openid', 'pending', now() + interval '10 minutes', now(), 5),
    -- NEGATIVE CONTROL: no token STARTS with \`applications:\`, so this row must
    -- come through byte-identical — spacing included (the rewrite normalizes
    -- whitespace on rows it touches).
    ('dc_m0003_2', 'cli_m0003_inst', 'UCM32', 'DCM32',
     'myapplications:read  https://ex.test/applications:read', 'pending', now() + interval '10 minutes', now(), 5);
`;

describe("scripts/migration/0003 — `app_` ids and the `application` vocabulary become `space`", () => {
  beforeEach(async () => {
    await execScript(CLEANUP);
    // The three CHECKs must never be left dropped, whatever the seed does.
    await withCatalogRestored(async () => {
      await execScript(DROP_LEVEL_CHECKS);
      await execScript(SEED);
    }, READD_LEVEL_CHECKS_NOT_VALID);
  });

  afterAll(async () => {
    // Leave the catalog as `0053` leaves it, so a later test file in the same
    // process sees the migrated baseline rather than this file's residue: the
    // three CHECKs present, and NOT VALID only where `0053` would have left them
    // so (`replayScript` promotes them, which is this file's doing and must not
    // outlive it).
    await withCatalogRestored(async () => {
      await execScript(CLEANUP);
      await execScript(DROP_LEVEL_CHECKS);
    }, READD_LEVEL_CHECKS_NOT_VALID);
  });

  // ── The id re-mint ─────────────────────────────────────────────────────────

  it("re-mints `spaces.id` and every referencing column, preserving the UUID", async () => {
    await replayScript();

    const ids = await rows<{ id: string }>(
      `SELECT id FROM spaces WHERE org_id = '${ORG}' ORDER BY id`,
    );
    expect(ids.map((r) => r.id)).toEqual([SPC_A, SPC_B]);
    // Both halves: the old form is gone AND the new form is exactly the old
    // UUID under the new prefix — not merely "something that is not app_".
    for (const { id } of ids) expect(id).toMatch(SPACE_ID_RE);

    const child = await one<Record<string, string | null>>(`
      SELECT (SELECT space_id FROM api_keys WHERE key_prefix = 'ask_m0003a')            AS api_key,
             (SELECT space_id FROM end_users WHERE id = 'eu_m0003')                     AS end_user,
             (SELECT space_id FROM audit_events WHERE org_id = '${ORG}')                AS audit_event,
             (SELECT space_id FROM files WHERE id = 'file_m0003_a')                     AS file,
             (SELECT space_id FROM uploads WHERE id = 'upl_m0003_a')                    AS upload,
             (SELECT space_id FROM webhooks WHERE id = 'wh_m0003_app')                  AS webhook,
             (SELECT space_id FROM webhooks WHERE id = 'wh_m0003_org')                  AS webhook_org,
             (SELECT referenced_space_id FROM oauth_clients WHERE id = 'oc_m0003_a')    AS oauth_client,
             (SELECT referenced_space_id FROM oauth_clients WHERE id = 'oc_m0003_i')    AS oauth_client_instance
    `);
    expect(child).toEqual({
      api_key: SPC_A,
      end_user: SPC_A,
      audit_event: SPC_A,
      file: SPC_A,
      upload: SPC_A,
      webhook: SPC_A,
      webhook_org: null, // an org-level webhook has no space and must stay NULL
      oauth_client: SPC_A,
      oauth_client_instance: null,
    });
  });

  it("leaves no `app_` survivor in any column that references `spaces`", async () => {
    await replayScript();

    // Catalog-driven rather than a list: it asks the same question the script's
    // own loop does, so an eighteenth foreign key added later is covered here
    // without editing this test.
    //
    // `audit_events.space_id` is UNIONed in for the same reason the script's
    // step 4 names it explicitly — `0055_schema_integrity_repairs` dropped its
    // foreign key (an `ON DELETE SET NULL` that blanked the attribution of
    // every deleted space), so the catalog sweep can no longer reach it. It is
    // still a pointer at a space and still has to be re-minted; without this
    // term the assertion below would go green on the exact regression that
    // matters, because the column it stopped covering is the one with no
    // constraint left to fail loudly.
    const survivors = await rows<{ ref: string; n: number }>(`
      SELECT format('%s.%s', t.relname, a.attname) AS ref,
             (xpath('/row/c/text()', query_to_xml(
                format('SELECT count(*) AS c FROM public.%I WHERE %I LIKE ''app\\_%%''',
                       t.relname, a.attname), false, true, '')))[1]::text::int AS n
        FROM pg_constraint c
        JOIN pg_class t     ON t.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'public.spaces'::regclass
      UNION
      SELECT 'audit_events.space_id',
             (SELECT count(*)::int FROM audit_events WHERE space_id LIKE 'app\\_%')
    `);
    // 19 FK columns + the constraint-less `audit_events.space_id`. Two of the
    // 19 arrived with `0056_space_roles` (`space_members.space_id`,
    // `chat_sessions.space_id`); 0003 derives the columns it rewrites FROM the
    // FK set, so it covers them without an edit — which is exactly the property
    // this count guards.
    expect(survivors.length).toBe(20);
    expect(survivors.filter((r) => r.n !== 0)).toEqual([]);
  });

  it("restores every foreign key into `spaces` with its ON DELETE behaviour intact", async () => {
    const before = await rows<{ child: string; conname: string; d: string }>(`
      SELECT conrelid::regclass::text AS child, conname, confdeltype AS d
        FROM pg_constraint
       WHERE contype = 'f' AND confrelid = 'public.spaces'::regclass
       ORDER BY 1, 2
    `);
    expect(before.length).toBe(19);

    await replayScript();

    const after = await rows<{ child: string; conname: string; d: string }>(`
      SELECT conrelid::regclass::text AS child, conname, confdeltype AS d
        FROM pg_constraint
       WHERE contype = 'f' AND confrelid = 'public.spaces'::regclass
       ORDER BY 1, 2
    `);
    // Byte-for-byte the same set, same names, same delete actions — all
    // nineteen `c` (cascade). `audit_events` used to be one more entry at
    // `n` (set null); `0055_schema_integrity_repairs` dropped that FK, because
    // the SET NULL was doing exactly what the old comment here warned a wrong
    // action would do — erasing the space attribution of every historical audit
    // row — and doing it on purpose, on every space delete.
    //
    // So the assertion inverts: a resurrected `n` now means either 0055 was
    // reverted or the capture/restore invented an action of its own.
    expect(after).toEqual(before);
    expect(after.filter((r) => r.d !== "c")).toEqual([]);
  });

  // ── Permission scope strings ───────────────────────────────────────────────

  it("rewrites `applications:*` scopes and leaves look-alike tokens untouched", async () => {
    await replayScript();

    const key = await one<{ scopes: string[] }>(
      `SELECT scopes FROM api_keys WHERE key_prefix = 'ask_m0003a'`,
    );
    expect([...key.scopes].sort()).toEqual([
      "myapplications:read", // NEGATIVE CONTROL — contains the word, does not start with it
      "runs:read",
      "spaces:read",
      "spaces:write",
      "workspaces:read", // NEGATIVE CONTROL — a real third-party scope
    ]);

    const alreadyCanonical = await one<{ scopes: string[] }>(
      `SELECT scopes FROM api_keys WHERE key_prefix = 'ask_m0003b'`,
    );
    expect(alreadyCanonical.scopes).toEqual(["spaces:read"]);

    const client = await one<{ scopes: string[] }>(
      `SELECT scopes FROM oauth_clients WHERE id = 'oc_m0003_a'`,
    );
    expect([...client.scopes].sort()).toEqual(["myapplications:read", "openid", "spaces:read"]);
  });

  it("rewrites the space-delimited scope shape per token, order preserved", async () => {
    const untouchedBefore = await one<{ scope: string }>(
      `SELECT scope FROM device_codes WHERE id = 'dc_m0003_2'`,
    );

    await replayScript();

    const rewritten = await one<{ scope: string }>(
      `SELECT scope FROM device_codes WHERE id = 'dc_m0003_1'`,
    );
    // `min(ord)` keeps the request order, which is the order echoed back into
    // the JWT `scope` claim.
    expect(rewritten.scope).toBe("spaces:read myapplications:read openid");

    // NEGATIVE CONTROL — a row the guard does not match keeps its original
    // bytes, DOUBLE SPACE included: whitespace normalization only happens on
    // rows the UPDATE actually touches.
    const untouched = await one<{ scope: string }>(
      `SELECT scope FROM device_codes WHERE id = 'dc_m0003_2'`,
    );
    expect(untouched.scope).toBe(untouchedBefore.scope);
    expect(untouched.scope).toBe("myapplications:read  https://ex.test/applications:read");
  });

  // ── Realms ─────────────────────────────────────────────────────────────────

  it("rewrites BOTH realm columns and no other realm value", async () => {
    await replayScript();

    const realms = await rows<{ id: string; realm: string }>(
      `SELECT id, realm FROM "user" WHERE id LIKE 'u_m0003%' ORDER BY id`,
    );
    expect(realms).toEqual([
      { id: "u_m0003_end", realm: `end_user:${SPC_A}` },
      { id: "u_m0003_platform", realm: "platform" },
      // NEGATIVE CONTROL — the LIKE-escape. An unescaped `end_user:app_%`
      // treats `_` as a wildcard and would rewrite this.
      { id: "u_m0003_sentinel", realm: "endXuser:appXsentinel" },
    ]);

    // `session.realm` is a DENORMALISED copy captured at session-create time
    // and it is the one the request-time guard reads. Rewriting only `user`
    // would reject every live end-user session with no other symptom.
    const sessions = await rows<{ id: string; realm: string }>(
      `SELECT id, realm FROM "session" WHERE id LIKE 'sess_m0003%' ORDER BY id`,
    );
    expect(sessions).toEqual([
      { id: "sess_m0003_end", realm: `end_user:${SPC_A}` },
      { id: "sess_m0003_plat", realm: "platform" },
    ]);

    // CROSS-CHECK for the third outcome: every end-user realm still names a row
    // that exists in `spaces`. Non-zero means the realm and the id moved
    // independently — the exact half-rewrite a single count cannot see.
    const dangling = await one<{ u: number; s: number }>(`
      SELECT (SELECT count(*)::int FROM "user" u
                WHERE u.id LIKE 'u_m0003%' AND u.realm LIKE 'end\\_user:%'
                  AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = substring(u.realm FROM 10))) AS u,
             (SELECT count(*)::int FROM "session" x
                WHERE x.id LIKE 'sess_m0003%' AND x.realm LIKE 'end\\_user:%'
                  AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = substring(x.realm FROM 10))) AS s
    `);
    expect(dangling).toEqual({ u: 0, s: 0 });
  });

  // ── Storage keys — deliberately NOT rewritten ──────────────────────────────
  //
  // The row's `space_id` moves; its `storage_key` does not, and the gap between
  // the two is the intended end state, not a half-rewrite. Nothing parses a
  // space id back out of a key (`parseStorageKey` returns the bucket only), the
  // key is only ever BUILT from a space id on the write path, and scoping reads
  // the `space_id` column — so the segment is an opaque historical path
  // component, exactly as `doc_` still is in these same keys after
  // `scripts/migration/0001`, which declined the identical rewrite for the
  // identical reason. Rewriting it would point every row at an object that does
  // not exist, because this script moves no bytes.
  //
  // These two tests are what makes that decision enforceable: re-add the
  // rewrite and they fail.

  it("leaves `files` / `uploads` storage keys on their `app_` path segment", async () => {
    await replayScript();

    const files = await rows<{ id: string; space_id: string; storage_key: string }>(
      `SELECT id, space_id, storage_key FROM files WHERE id LIKE 'file_m0003%' ORDER BY id`,
    );
    expect(files).toEqual([
      {
        id: "file_m0003_a",
        space_id: SPC_A,
        storage_key: `files/${APP_A}/file_m0003_a/report.html`,
      },
      {
        id: "file_m0003_b",
        space_id: SPC_B,
        storage_key: `files/${APP_B}/file_m0003_b/app_notes.md`,
      },
    ]);

    const upload = await one<{ space_id: string; storage_key: string }>(
      `SELECT space_id, storage_key FROM uploads WHERE id = 'upl_m0003_a'`,
    );
    expect(upload.space_id).toBe(SPC_A);
    expect(upload.storage_key).toBe(`uploads/${APP_A}/upl_m0003_a/a.txt`);
  });

  it("rewrites the outbox `reason` and leaves every outbox key untouched", async () => {
    await replayScript();

    const jobs = await rows<{ id: string; bucket: string; storage_key: string; reason: string }>(
      `SELECT id, bucket, storage_key, reason FROM storage_deletion_jobs
        WHERE id LIKE 'sdj_m0003%' ORDER BY id`,
    );
    expect(jobs).toEqual([
      // The outbox stores the key WITHIN the bucket, so the space id is segment
      // ONE here — a different position from `files`/`uploads` above.
      // `reason` IS rewritten (step 9); the KEY beside it is not — the two
      // halves of this row are the whole point of the assertion.
      {
        id: "sdj_m0003_1",
        bucket: "files",
        storage_key: `${APP_A}/file_m0003_a/report.html`,
        reason: "space_deleted",
      },
      {
        id: "sdj_m0003_2",
        bucket: "uploads",
        storage_key: `${APP_A}/upl_m0003_a/a.txt`,
        reason: "upload_expired",
      },
      // The remaining three rows span the other buckets and the `app_`
      // lookalike shapes, so the assertion covers the whole column, not just
      // the two buckets a rewrite would have targeted.
      {
        id: "sdj_m0003_3",
        bucket: "run-workspace",
        storage_key: "app_lookalike_run/files/brief.pdf",
        reason: "run_workspace_deleted",
      },
      {
        id: "sdj_m0003_4",
        bucket: "agent-packages",
        storage_key: "app_owner/pkg/1.0.0.afps",
        reason: "version_deleted",
      },
      {
        id: "sdj_m0003_5",
        bucket: "files",
        storage_key: "appXsentinel/file_x/a.txt",
        reason: "file_deleted",
      },
    ]);
  });

  // ── The `level` vocabulary and the three deferred constraints ──────────────

  it("rewrites both `level` columns and promotes the three NOT VALID constraints", async () => {
    const before = await rows<{ conname: string; convalidated: boolean }>(`
      SELECT conname, convalidated FROM pg_constraint
       WHERE conname IN ('webhooks_level_values', 'webhooks_level_check', 'oauth_clients_level_check')
       ORDER BY 1
    `);
    expect(before.map((r) => r.convalidated)).toEqual([false, false, false]);

    await replayScript();

    const levels = await one<{ wh: string; wh_org: string; oc: string; oc_inst: string }>(`
      SELECT (SELECT level FROM webhooks      WHERE id = 'wh_m0003_app') AS wh,
             (SELECT level FROM webhooks      WHERE id = 'wh_m0003_org') AS wh_org,
             (SELECT level FROM oauth_clients WHERE id = 'oc_m0003_a')   AS oc,
             (SELECT level FROM oauth_clients WHERE id = 'oc_m0003_i')   AS oc_inst
    `);
    expect(levels).toEqual({ wh: "space", wh_org: "org", oc: "space", oc_inst: "instance" });

    // STRUCTURAL CROSS-CHECK. `convalidated = true` is proof the whole table was
    // re-scanned and holds no legacy literal — something no `count(*) = 0`
    // query over the seeded rows can establish.
    const after = await rows<{ conname: string; convalidated: boolean }>(`
      SELECT conname, convalidated FROM pg_constraint
       WHERE conname IN ('webhooks_level_values', 'webhooks_level_check', 'oauth_clients_level_check')
       ORDER BY 1
    `);
    expect(after.map((r) => r.convalidated)).toEqual([true, true, true]);
  });

  // ── Triggers ───────────────────────────────────────────────────────────────

  it("re-enables every trigger it disabled, and the immutability guard still bites", async () => {
    const triggerCatalog = () =>
      rows<{ tgname: string; tbl: string; tgenabled: string }>(`
        SELECT tgname, tgrelid::regclass::text AS tbl, tgenabled
          FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2
      `);

    // GUARD, and a deliberate tripwire. The four `createNotifyTriggers()` names
    // must be FREE here: they are a boot-time artifact installed from
    // `bootBackground()`, and the harness never boots the API. If one of them is
    // already present, something has turned it into a MIGRATION artifact — the
    // exact regression that made `run_metric-streaming` and
    // `run-metric-broadcaster` receive one extra `send` per assertion, because
    // triggers a migration installs are in every database the drizzle chain
    // touches and no `afterAll` can take them back. Fail here rather than
    // letting the probe below clobber a real trigger.
    const preexisting = await triggerCatalog();
    expect(preexisting.filter((t) => NOTIFY_TRIGGER_NAMES.includes(t.tgname))).toEqual([]);

    await execScript(PROBE_INSTALL);
    try {
      // CAPTURED, NOT HARDCODED — and this is the point of the test.
      //
      // The script disables three triggers by name. Only ONE is unconditionally
      // present: `oauth_clients_level_immutable`, created by raw SQL in
      // `0003_fold_oidc_tables.sql` and therefore replayed by every database.
      // The other two are the probe's, installed a moment ago.
      //
      // A hardcoded four-row expectation asserted an environment fact rather
      // than a property of the script — it could only pass where something else
      // had installed those triggers, and silently became a check on that
      // something else. The real invariant is symmetry: the script disables
      // triggers and must put the catalog back exactly as it found it, whatever
      // "as it found it" is. So snapshot and demand equality.
      //
      // `NOT tgisinternal` excludes the RI constraint triggers, whose generated
      // names embed OIDs and would churn purely because the script drops and
      // restores the seventeen foreign keys.
      const before = await triggerCatalog();

      // Non-vacuity: all three triggers the script actually disables are here,
      // enabled. Without this the equality below could hold over two empty lists.
      for (const [tgname, tbl] of [
        ["oauth_clients_level_immutable", "oauth_clients"],
        ["runs_notify_update_trigger", "runs"],
        ["integration_connections_notify_trigger", "integration_connections"],
      ] as const) {
        expect(before).toContainEqual({ tgname, tbl, tgenabled: "O" });
      }
      // Nothing may start out disabled, or "unchanged" would not mean "enabled".
      expect(before.filter((t) => t.tgenabled !== "O")).toEqual([]);

      await replayScript();

      const after = await triggerCatalog();
      // Same triggers, same tables, same enable flags. A trigger the script left
      // disabled shows up as an `O` → `D` diff; one it dropped or added shows up
      // as a missing or extra row.
      expect(after).toEqual(before);
      // Stated separately so a failure names the symptom instead of making the
      // reader diff two lists.
      expect(after.filter((t) => t.tgenabled !== "O")).toEqual([]);

      // THE OTHER HALF: `tgenabled = 'O'` afterwards proves the script put the
      // flag back, not that it ever took it away. The script rewrote the seeded
      // `runs.space_id` and `integration_connections.space_id` — both firing
      // conditions — so if steps 2 and 6 were deleted, both triggers would have
      // fired and, in production, queued one `pg_notify` per historical row to
      // every live SSE subscriber. The probe must be empty.
      const fired = await rows<{ tgname: string; op: string }>(
        `SELECT tgname, op FROM _m0003_notify_probe ORDER BY 1, 2`,
      );
      expect(fired).toEqual([]);

      // POSITIVE CONTROL for that emptiness. An empty probe proves suppression
      // only if the probe can record at all — so make both triggers fire now,
      // through the same firing conditions the rewrite used, and watch it fill.
      await db.execute(sql.raw(`UPDATE runs SET status = 'failed' WHERE id = 'run_m0003_a'`));
      await db.execute(
        sql.raw(
          `UPDATE integration_connections SET needs_reconnection = true WHERE account_id = 'acct_m0003'`,
        ),
      );
      expect(
        await rows<{ tgname: string; op: string }>(
          `SELECT tgname, op FROM _m0003_notify_probe ORDER BY 1, 2`,
        ),
      ).toEqual([
        { tgname: "integration_connections_notify_trigger", op: "UPDATE" },
        { tgname: "runs_notify_update_trigger", op: "UPDATE" },
      ]);
    } finally {
      // The probe must never outlive this test: triggers under the real names
      // are precisely what breaks the `run_metric` suites downstream.
      await execScript(PROBE_DROP);
    }

    // `tgenabled = 'O'` says the catalog flag is back; this says the trigger
    // actually fires. The script's own level rewrite is the ONE change it is
    // allowed to make, and it must not leave the door open behind it.
    let raised: unknown = null;
    try {
      await db.execute(sql.raw(`UPDATE oauth_clients SET level = 'org' WHERE id = 'oc_m0003_a'`));
    } catch (error) {
      raised = error;
    }
    // Drizzle wraps the driver error, so the trigger's own message is on
    // `cause` — assert on both so neither driver's shape can pass vacuously.
    const err = raised as (Error & { cause?: unknown }) | null;
    expect(err).not.toBeNull();
    const text = `${err?.message ?? ""} ${(err?.cause as Error | undefined)?.message ?? ""}`;
    expect(text).toMatch(/immutable/i);
  });

  // ── What must NOT move ─────────────────────────────────────────────────────

  it("does not rewrite the append-only audit vocabulary", async () => {
    await replayScript();

    // `audit_events` is a record of what happened AT THE TIME. Rewriting it
    // falsifies the history it exists to keep, so a `GROUP BY action` stays
    // permanently split across two spellings — one per era. That is the
    // intended outcome, not an omission.
    const event = await one<{ action: string; resource_type: string; resource_id: string }>(
      `SELECT action, resource_type, resource_id FROM audit_events WHERE org_id = '${ORG}'`,
    );
    expect(event.action).toBe("application.created");
    expect(event.resource_type).toBe("application");
    // …including the id INSIDE the record. Only the live FK column moved.
    expect(event.resource_id).toBe(APP_A);
  });

  // ── Idempotency ────────────────────────────────────────────────────────────

  it("is idempotent — a second pass changes nothing", async () => {
    const snapshot = async () =>
      JSON.stringify({
        spaces: await rows(`SELECT id, name FROM spaces WHERE org_id = '${ORG}' ORDER BY id`),
        keys: await rows(
          `SELECT key_prefix, space_id, scopes::text FROM api_keys WHERE org_id = '${ORG}' ORDER BY key_prefix`,
        ),
        files: await rows(
          `SELECT id, space_id, storage_key FROM files WHERE id LIKE 'file_m0003%' ORDER BY id`,
        ),
        jobs: await rows(
          `SELECT id, bucket, storage_key, reason FROM storage_deletion_jobs WHERE id LIKE 'sdj_m0003%' ORDER BY id`,
        ),
        users: await rows(`SELECT id, realm FROM "user" WHERE id LIKE 'u_m0003%' ORDER BY id`),
        sessions: await rows(
          `SELECT id, realm FROM "session" WHERE id LIKE 'sess_m0003%' ORDER BY id`,
        ),
        codes: await rows(
          `SELECT id, scope FROM device_codes WHERE id LIKE 'dc_m0003%' ORDER BY id`,
        ),
        clients: await rows(
          `SELECT id, level, referenced_space_id, scopes::text FROM oauth_clients WHERE id LIKE 'oc_m0003%' ORDER BY id`,
        ),
        hooks: await rows(
          `SELECT id, level, space_id FROM webhooks WHERE org_id = '${ORG}' ORDER BY id`,
        ),
        audit: await rows(
          `SELECT action, resource_type, resource_id, space_id FROM audit_events WHERE org_id = '${ORG}'`,
        ),
        fks: await rows(
          `SELECT conrelid::regclass::text AS child, conname, confdeltype FROM pg_constraint
            WHERE contype = 'f' AND confrelid = 'public.spaces'::regclass ORDER BY 1, 2`,
        ),
      });

    await replayScript();
    const afterFirst = await snapshot();

    await replayScript();
    expect(await snapshot()).toBe(afterFirst);
  });
});
