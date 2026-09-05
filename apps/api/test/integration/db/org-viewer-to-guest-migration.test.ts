// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0008-org-viewer-to-guest.sql` against a seeded database.
 *
 * The script is what stands between `0056_space_roles` and a running platform,
 * so the counts it prints are the deploy's go/no-go signal, and this file
 * asserts the ones that discriminate — a `viewer` becomes a `guest` and gains
 * one explicit `viewer` row per space that existed.
 *
 * Like `application-ids-to-space-ids-migration.test.ts`, it seeds with raw SQL
 * and does not use `createTestContext`: the pre-migration state (`role =
 * 'viewer'`) is one the TS enum cannot mint, which is the whole point.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, toRows, getPGliteClient, reservePgConnection } from "@appstrate/db/client";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser } from "../../helpers/auth.ts";
import { getTestApp } from "../../helpers/app.ts";

const SCRIPT = new URL(
  "../../../../../scripts/migration/0008-org-viewer-to-guest.sql",
  import.meta.url,
).pathname;

const ORG = "e0000000-0000-4000-8000-00000000d008";
const SPACE_DEFAULT = "spc_d0080000-0000-4000-8000-000000000001";
const SPACE_OTHER = "spc_d0080000-0000-4000-8000-000000000002";
const VIEWER_A = "usr_0008_viewer_a";
const VIEWER_B = "usr_0008_viewer_b";
const MEMBER = "usr_0008_member";

/**
 * Run a multi-statement script through the raw driver. `db.execute` speaks the
 * extended protocol (one statement per call) and the script is a
 * `BEGIN … COMMIT` block full of `DO $$ … $$` bodies.
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
 * `25P02`s every later query in the process. See the same helper's long note in
 * `application-ids-to-space-ids-migration.test.ts`.
 */
async function endAbortedTransaction(exec: (s: string) => Promise<unknown>): Promise<void> {
  try {
    await exec("ROLLBACK");
  } catch {
    /* nothing to roll back */
  }
}

async function count(query: string): Promise<number> {
  const rows = toRows<{ n: number | string }>(await db.execute(sql.raw(query)));
  return Number(rows[0]?.n ?? -1);
}

async function seed(): Promise<void> {
  await execScript(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero Eight', 'zero-eight-0008');
    INSERT INTO spaces (id, org_id, name, is_default)
      VALUES ('${SPACE_DEFAULT}', '${ORG}', 'Default', true),
             ('${SPACE_OTHER}', '${ORG}', 'Other', false);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${VIEWER_A}', 'Viewer A', 'a-0008@example.com', true, now(), now()),
      ('${VIEWER_B}', 'Viewer B', 'b-0008@example.com', true, now(), now()),
      ('${MEMBER}',   'Member',   'm-0008@example.com', true, now(), now());
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('${ORG}', '${VIEWER_A}', 'viewer'),
      ('${ORG}', '${VIEWER_B}', 'viewer'),
      ('${ORG}', '${MEMBER}',   'member');
    INSERT INTO org_invitations (id, token, email, org_id, role, status, expires_at) VALUES
      ('inv_0008_pending',  'tok_0008_pending',  'p-0008@example.com', '${ORG}', 'viewer', 'pending',  now() + interval '7 days'),
      ('inv_0008_expired',  'tok_0008_expired',  'e-0008@example.com', '${ORG}', 'viewer', 'expired',  now() - interval '1 day'),
      ('inv_0008_member',   'tok_0008_member',   'k-0008@example.com', '${ORG}', 'member', 'pending',  now() + interval '7 days');
  `);
}

describe("scripts/migration/0008 — org `viewer` becomes `guest` + explicit space rows", () => {
  beforeEach(async () => {
    await truncateAll();
    await seed();
  });

  afterEach(async () => {
    await truncateAll();
  });

  it("moves every half, and the counts discriminate", async () => {
    // Before: the state the script exists for.
    expect(await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'viewer'`)).toBe(2);
    expect(await count(`SELECT count(*)::int AS n FROM space_members`)).toBe(0);

    await execScript(await Bun.file(SCRIPT).text());

    // 1. Every viewer got a `viewer` row in every space that existed — the
    //    product, not merely "more than zero", is what proves step 1 ran
    //    before step 2 erased the evidence.
    expect(await count(`SELECT count(*)::int AS n FROM space_members`)).toBe(4);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM space_members WHERE preset_role = 'viewer'
           AND user_id IN ('${VIEWER_A}', '${VIEWER_B}')`,
      ),
    ).toBe(4);
    // The member was NOT given rows: they are implicit in the open space.
    expect(
      await count(`SELECT count(*)::int AS n FROM space_members WHERE user_id = '${MEMBER}'`),
    ).toBe(0);

    // 2. The org role itself.
    expect(await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'viewer'`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'guest'`)).toBe(2);
    expect(await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'member'`)).toBe(1);

    const invitation = toRows<{ assignments: unknown }>(
      await db.execute(sql`
      SELECT space_assignments AS assignments FROM org_invitations WHERE id = 'inv_0008_pending'
    `),
    )[0]!;
    expect(invitation.assignments).toEqual([
      { space_id: SPACE_DEFAULT, preset_role: "viewer" },
      { space_id: SPACE_OTHER, preset_role: "viewer" },
    ]);

    // 3. A PENDING viewer invitation lands as a guest; a non-pending one is
    //    left alone (it can never be accepted, and rewriting it would edit
    //    history).
    expect(
      await count(
        `SELECT count(*)::int AS n FROM org_invitations WHERE id = 'inv_0008_pending' AND role = 'guest'`,
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM org_invitations WHERE id = 'inv_0008_expired' AND role = 'viewer'`,
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM org_invitations WHERE id = 'inv_0008_member' AND role = 'member'`,
      ),
    ).toBe(1);
  });

  it("is idempotent — a second run changes nothing", async () => {
    const source = await Bun.file(SCRIPT).text();
    await execScript(source);
    const after = {
      members: await count(`SELECT count(*)::int AS n FROM space_members`),
      guests: await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'guest'`),
    };

    await execScript(source);

    expect(await count(`SELECT count(*)::int AS n FROM space_members`)).toBe(after.members);
    expect(await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'guest'`)).toBe(
      after.guests,
    );
  });

  it("a migrated pending viewer invitation accepts with its original space reach", async () => {
    await execScript(await Bun.file(SCRIPT).text());
    const invitee = await createTestUser({ email: "p-0008@example.com" });
    const app = getTestApp();
    const response = await app.request("/invite/tok_0008_pending/accept", {
      method: "POST",
      headers: { Cookie: invitee.cookie },
    });
    expect(response.status).toBe(200);
    const rows = toRows<{ space_id: string; preset_role: string }>(
      await db.execute(sql`
      SELECT space_id, preset_role FROM space_members WHERE user_id = ${invitee.id} ORDER BY space_id
    `),
    );
    expect(rows).toEqual([
      { space_id: SPACE_DEFAULT, preset_role: "viewer" },
      { space_id: SPACE_OTHER, preset_role: "viewer" },
    ]);
  });

  it("0056 snapshots legacy OAuth viewer signups and never adds later spaces on replay", async () => {
    await execScript(`
      ALTER TABLE oauth_clients DROP CONSTRAINT oauth_clients_signup_role_check;
      INSERT INTO oauth_clients (id, client_id, name, level, referenced_org_id, signup_role, redirect_uris)
      VALUES ('oac_0008','oauth_0008','Legacy viewer','org','${ORG}','viewer','{}');
    `);
    const migration = await Bun.file(
      new URL("../../../../../packages/db/drizzle/0056_space_roles.sql", import.meta.url),
    ).text();
    const section = migration.slice(migration.indexOf("-- ═══ G."));
    await execScript(`BEGIN; ${section} COMMIT;`);
    const policy = async () =>
      toRows<{ role: string; assignments: unknown }>(
        await db.execute(sql`
      SELECT signup_role AS role, signup_space_assignments AS assignments FROM oauth_clients WHERE id = 'oac_0008'
    `),
      )[0]!;
    const expected = {
      role: "guest",
      assignments: [
        { space_id: SPACE_DEFAULT, preset_role: "viewer" },
        { space_id: SPACE_OTHER, preset_role: "viewer" },
      ],
    };
    expect(await policy()).toEqual(expected);
    await execScript(
      `INSERT INTO spaces (id, org_id, name) VALUES ('spc_d0080000-0000-4000-8000-000000000003','${ORG}','Later')`,
    );
    await execScript(`BEGIN; ${section} COMMIT;`);
    expect(await policy()).toEqual(expected);
  });

  it("snapshots pending invitations without changing explicit choices or widening on rerun", async () => {
    await execScript(
      `UPDATE org_invitations SET space_assignments = '[{"space_id":"${SPACE_OTHER}","preset_role":"builder"}]'::jsonb WHERE id = 'inv_0008_pending'`,
    );
    const source = await Bun.file(SCRIPT).text();
    await execScript(source);
    const snapshot = async () =>
      toRows<{ assignments: unknown }>(
        await db.execute(sql`
      SELECT space_assignments AS assignments FROM org_invitations WHERE id = 'inv_0008_pending'
    `),
      )[0]!.assignments;
    expect(await snapshot()).toEqual([
      { space_id: SPACE_OTHER, preset_role: "builder" },
      { space_id: SPACE_DEFAULT, preset_role: "viewer" },
    ]);
    await execScript(
      `INSERT INTO spaces (id, org_id, name) VALUES ('spc_d0080000-0000-4000-8000-000000000003','${ORG}','Later')`,
    );
    await execScript(source);
    expect(await snapshot()).toEqual([
      { space_id: SPACE_OTHER, preset_role: "builder" },
      { space_id: SPACE_DEFAULT, preset_role: "viewer" },
    ]);
  });

  it("leaves a hand-added row alone rather than overwriting its role", async () => {
    // An admin who already granted this person `builder` before the migration
    // keeps that decision — `ON CONFLICT DO NOTHING`, not `DO UPDATE`.
    await execScript(
      `INSERT INTO space_members (space_id, user_id, preset_role)
         VALUES ('${SPACE_OTHER}', '${VIEWER_A}', 'builder');`,
    );

    await execScript(await Bun.file(SCRIPT).text());

    expect(
      await count(
        `SELECT count(*)::int AS n FROM space_members
           WHERE space_id = '${SPACE_OTHER}' AND user_id = '${VIEWER_A}' AND preset_role = 'builder'`,
      ),
    ).toBe(1);
    // …and the other three rows were still inserted.
    expect(await count(`SELECT count(*)::int AS n FROM space_members`)).toBe(4);
  });
});
