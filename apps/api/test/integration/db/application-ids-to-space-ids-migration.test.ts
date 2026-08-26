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

const SPACE_ID_RE = /^spc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
    await pglite.exec(source);
    return;
  }
  const conn = await reservePgConnection();
  if (!conn) throw new Error("no raw database connection available");
  try {
    await conn.sql.unsafe(source);
  } finally {
    conn.release();
  }
}

async function replayScript(): Promise<void> {
  await execScript(await Bun.file(SCRIPT).text());
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

const CLEANUP = `
  DELETE FROM device_codes WHERE id LIKE 'dc_m0003%';
  DELETE FROM oauth_clients WHERE client_id LIKE 'cli_m0003%';
  DELETE FROM storage_deletion_jobs WHERE id LIKE 'sdj_m0003%';
  DELETE FROM audit_events WHERE org_id = '${ORG}';
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

  INSERT INTO audit_events (org_id, space_id, actor_type, actor_id, action, resource_type, resource_id)
  VALUES ('${ORG}', '${APP_A}', 'user', 'u_m0003_platform', 'application.created', 'application', '${APP_A}');

  INSERT INTO files (id, org_id, space_id, purpose, storage_key, name, mime, size, sha256) VALUES
    ('file_m0003_a', '${ORG}', '${APP_A}', 'agent_output',
     'files/${APP_A}/file_m0003_a/report.html', 'report.html', 'text/html', 1, 'x'),
    -- NEGATIVE CONTROL: a FILENAME carrying the retired prefix. The rewrite is
    -- pinned to the segment after the first slash, so this must survive.
    ('file_m0003_b', '${ORG}', '${APP_B}', 'agent_output',
     'files/${APP_B}/file_m0003_b/app_notes.md', 'app_notes.md', 'text/markdown', 1, 'y');

  INSERT INTO uploads (id, org_id, space_id, storage_key, name, mime, size, expires_at)
  VALUES ('upl_m0003_a', '${ORG}', '${APP_A}', 'uploads/${APP_A}/upl_m0003_a/a.txt',
          'a.txt', 'text/plain', 1, now() + interval '1 hour');

  INSERT INTO storage_deletion_jobs (id, bucket, storage_key, reason) VALUES
    ('sdj_m0003_1', 'files',        '${APP_A}/file_m0003_a/report.html', 'application_deleted'),
    ('sdj_m0003_2', 'uploads',      '${APP_A}/upl_m0003_a/a.txt',        'upload_expired'),
    -- NEGATIVE CONTROL: a RUN-workspace key. Segment 1 is a run id, not a space
    -- id, so the bucket filter — not the shape — is what must keep it out.
    ('sdj_m0003_3', 'run-workspace', 'app_lookalike_run/files/brief.pdf', 'run_workspace_deleted'),
    -- NEGATIVE CONTROL: an owner namespace in a third bucket.
    ('sdj_m0003_4', 'agent-packages', 'app_owner/pkg/1.0.0.afps',         'version_deleted'),
    -- NEGATIVE CONTROL for the LIKE-escape, in a bucket the rewrite DOES reach.
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
    await execScript(DROP_LEVEL_CHECKS);
    await execScript(SEED);
    await execScript(READD_LEVEL_CHECKS_NOT_VALID);
  });

  afterAll(async () => {
    await execScript(CLEANUP);
    // Leave the catalog as `0053` leaves it, so a later test file in the same
    // process sees the migrated baseline rather than this file's residue.
    await execScript(DROP_LEVEL_CHECKS);
    await execScript(READD_LEVEL_CHECKS_NOT_VALID);
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
    // own loop does, so a nineteenth foreign key added later is covered here
    // without editing this test.
    const survivors = await rows<{ ref: string; n: number }>(`
      SELECT format('%s.%s', t.relname, a.attname) AS ref,
             (xpath('/row/c/text()', query_to_xml(
                format('SELECT count(*) AS c FROM public.%I WHERE %I LIKE ''app\\_%%''',
                       t.relname, a.attname), false, true, '')))[1]::text::int AS n
        FROM pg_constraint c
        JOIN pg_class t     ON t.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.confrelid = 'public.spaces'::regclass
    `);
    expect(survivors.length).toBe(18);
    expect(survivors.filter((r) => r.n !== 0)).toEqual([]);
  });

  it("restores all eighteen foreign keys with their ON DELETE behaviour intact", async () => {
    const before = await rows<{ child: string; conname: string; d: string }>(`
      SELECT conrelid::regclass::text AS child, conname, confdeltype AS d
        FROM pg_constraint
       WHERE contype = 'f' AND confrelid = 'public.spaces'::regclass
       ORDER BY 1, 2
    `);
    expect(before.length).toBe(18);

    await replayScript();

    const after = await rows<{ child: string; conname: string; d: string }>(`
      SELECT conrelid::regclass::text AS child, conname, confdeltype AS d
        FROM pg_constraint
       WHERE contype = 'f' AND confrelid = 'public.spaces'::regclass
       ORDER BY 1, 2
    `);
    // Byte-for-byte the same set, same names, same delete actions. Seventeen
    // `c` (cascade) and exactly one `n` (set null) — `audit_events`. Getting
    // that one wrong would silently convert "keep the audit row, forget the
    // space" into "delete the audit trail with the space".
    expect(after).toEqual(before);
    expect(after.filter((r) => r.d !== "c").map((r) => r.child)).toEqual(["audit_events"]);
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

  // ── Storage keys ───────────────────────────────────────────────────────────

  it("rewrites the space-id segment of every storage key and nothing else", async () => {
    await replayScript();

    const files = await rows<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM files WHERE id LIKE 'file_m0003%' ORDER BY id`,
    );
    expect(files).toEqual([
      { id: "file_m0003_a", storage_key: `files/${SPC_A}/file_m0003_a/report.html` },
      // NEGATIVE CONTROL — the FILENAME keeps its `app_`. The rewrite is pinned
      // to the segment after the first slash, so a later segment is out of reach.
      { id: "file_m0003_b", storage_key: `files/${SPC_B}/file_m0003_b/app_notes.md` },
    ]);

    const upload = await one<{ storage_key: string }>(
      `SELECT storage_key FROM uploads WHERE id = 'upl_m0003_a'`,
    );
    expect(upload.storage_key).toBe(`uploads/${SPC_A}/upl_m0003_a/a.txt`);

    // CROSS-CHECK — the key's space segment against the row's OWN `space_id`.
    // This holds in BOTH consistent states and is non-zero in exactly the
    // mangled one, which is why it is here and not just a "legacy = 0" count.
    const drift = await one<{ f: number; u: number }>(`
      SELECT (SELECT count(*)::int FROM files   WHERE split_part(storage_key, '/', 2) <> space_id) AS f,
             (SELECT count(*)::int FROM uploads WHERE split_part(storage_key, '/', 2) <> space_id) AS u
    `);
    expect(drift).toEqual({ f: 0, u: 0 });
  });

  it("rewrites outbox keys only in the buckets whose keys start with a space id", async () => {
    await replayScript();

    const jobs = await rows<{ id: string; bucket: string; storage_key: string; reason: string }>(
      `SELECT id, bucket, storage_key, reason FROM storage_deletion_jobs
        WHERE id LIKE 'sdj_m0003%' ORDER BY id`,
    );
    expect(jobs).toEqual([
      // The outbox stores the key WITHIN the bucket, so the space id is segment
      // ONE here — a different position from `files`/`uploads` above.
      {
        id: "sdj_m0003_1",
        bucket: "files",
        storage_key: `${SPC_A}/file_m0003_a/report.html`,
        reason: "space_deleted",
      },
      {
        id: "sdj_m0003_2",
        bucket: "uploads",
        storage_key: `${SPC_A}/upl_m0003_a/a.txt`,
        reason: "upload_expired",
      },
      // NEGATIVE CONTROL — segment 1 is a RUN id here, and it looks exactly
      // like a space id. Only the bucket filter keeps it out.
      {
        id: "sdj_m0003_3",
        bucket: "run-workspace",
        storage_key: "app_lookalike_run/files/brief.pdf",
        reason: "run_workspace_deleted",
      },
      // NEGATIVE CONTROL — a third bucket, keyed by owner namespace.
      {
        id: "sdj_m0003_4",
        bucket: "agent-packages",
        storage_key: "app_owner/pkg/1.0.0.afps",
        reason: "version_deleted",
      },
      // NEGATIVE CONTROL — the LIKE-escape, inside a bucket the rewrite DOES
      // reach. `LIKE 'app_%'` unescaped would rewrite this.
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
    await replayScript();

    const triggers = await rows<{ tgname: string; tgenabled: string }>(`
      SELECT tgname, tgenabled FROM pg_trigger
       WHERE tgname IN ('oauth_clients_level_immutable', 'runs_notify_update_trigger',
                        'runs_notify_insert_trigger', 'integration_connections_notify_trigger')
       ORDER BY 1
    `);
    expect(triggers).toEqual([
      { tgname: "integration_connections_notify_trigger", tgenabled: "O" },
      { tgname: "oauth_clients_level_immutable", tgenabled: "O" },
      { tgname: "runs_notify_insert_trigger", tgenabled: "O" },
      { tgname: "runs_notify_update_trigger", tgenabled: "O" },
    ]);

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
