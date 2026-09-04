// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0008-org-viewer-to-guest.sql` against a seeded database.
 *
 * The script is what stands between `0056_space_roles` and a running platform:
 * until it has run, every `viewer` is locked out by `UnmigratedOrgRoleError`.
 * So the counts it prints are the deploy's go/no-go signal, and this file
 * asserts the three that discriminate — a `viewer` becomes a `guest`, gains one
 * explicit `viewer` row per space that existed, and every chat session gets a
 * space.
 *
 * Like `application-ids-to-space-ids-migration.test.ts`, it seeds with raw SQL
 * and does not use `createTestContext`: the pre-migration state (`role =
 * 'viewer'`) is one the TS enum can no longer mint, which is the whole point.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db, toRows, getPGliteClient, reservePgConnection } from "@appstrate/db/client";
import { truncateAll } from "../../helpers/db.ts";

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
    INSERT INTO chat_sessions (id, org_id, user_id) VALUES
      ('chs_0008_a', '${ORG}', '${VIEWER_A}'),
      ('chs_0008_b', '${ORG}', '${MEMBER}');
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
    expect(await count(`SELECT count(*)::int AS n FROM chat_sessions WHERE space_id IS NULL`)).toBe(
      2,
    );

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

    // 4. Chat sessions land in the org's default space, not the other one.
    expect(await count(`SELECT count(*)::int AS n FROM chat_sessions WHERE space_id IS NULL`)).toBe(
      0,
    );
    expect(
      await count(
        `SELECT count(*)::int AS n FROM chat_sessions WHERE space_id = '${SPACE_DEFAULT}'`,
      ),
    ).toBe(2);
  });

  it("is idempotent — a second run changes nothing", async () => {
    const source = await Bun.file(SCRIPT).text();
    await execScript(source);
    const after = {
      members: await count(`SELECT count(*)::int AS n FROM space_members`),
      guests: await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'guest'`),
      sessions: await count(
        `SELECT count(*)::int AS n FROM chat_sessions WHERE space_id = '${SPACE_DEFAULT}'`,
      ),
    };

    await execScript(source);

    expect(await count(`SELECT count(*)::int AS n FROM space_members`)).toBe(after.members);
    expect(await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'guest'`)).toBe(
      after.guests,
    );
    expect(
      await count(
        `SELECT count(*)::int AS n FROM chat_sessions WHERE space_id = '${SPACE_DEFAULT}'`,
      ),
    ).toBe(after.sessions);
  });

  it("aborts and rolls back when its own verification fails", async () => {
    // The guard has to be provable, not just present. An org with no DEFAULT
    // space leaves step 4 with a null-space chat session, which step 5 refuses
    // — and because the whole script is one transaction, the role flip in
    // step 2 goes back with it.
    await execScript(
      `INSERT INTO organizations (id, name, slug)
         VALUES ('e0000000-0000-4000-8000-00000000d009', 'No Default', 'no-default-0008');
       INSERT INTO chat_sessions (id, org_id, user_id)
         VALUES ('chs_0008_orphan', 'e0000000-0000-4000-8000-00000000d009', '${VIEWER_A}');`,
    );

    await expect(execScript(await Bun.file(SCRIPT).text())).rejects.toThrow(
      /chat session\(s\) still have no space/,
    );

    // Nothing moved: the transaction rolled back whole.
    expect(await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'viewer'`)).toBe(2);
    expect(await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'guest'`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM space_members`)).toBe(0);
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
