// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0008-org-viewer-to-guest.sql` — the behaviour of the
 * script itself, on a database replayed to `0058`.
 *
 * ═══ WHY THIS FILE IS NOT AN INTEGRATION TEST ═══
 *
 * It was one, until `0059_drop_org_viewer.sql` entered the journal. The
 * integration suite shares one database and applies the journal to head, so
 * `role = 'viewer'` — the pre-state this whole script exists to repair — became
 * unseedable there: every case raised
 * `22P02 invalid input value for enum org_role: "viewer"`.
 *
 * That makes the FIXTURE unreachable, not the claims. `0008` is still the
 * documented upgrade path for any installation that has viewers
 * (`scripts/migration/README.md`), and after `0059` it is the ONLY thing that
 * still writes them — so it is exactly the code that must keep its coverage.
 * The subject is recovered the way `migration-0059-drop-org-viewer.test.ts`
 * recovers it: replay the journal to `0058` into a private PGlite instance, one
 * migration short of the narrowing, and seed there.
 *
 * ═══ A FRESH INSTANCE PER CASE, ON PURPOSE ═══
 *
 * `0008` is globally scoped — `UPDATE org_members SET role = 'guest' WHERE role
 * = 'viewer'` carries no org filter, and its step 4 targets every client whose
 * snapshot is still empty. Cases cannot be isolated by using disjoint
 * organizations inside one instance: the first case to run the script migrates
 * every other case's fixture. So `beforeEach` builds a new database, which also
 * preserves the deleted file's fresh-state-per-case semantics verbatim.
 *
 * The replay costs ~2s, so the whole file is a few seconds — cheap enough that
 * buying isolation with it is the right trade.
 *
 * ═══ THE SEED IS 2 VIEWERS x 2 SPACES, AND THE PRODUCT IS THE CLAIM ═══
 *
 * `0008` writes one `space_members` row per space a viewer reaches. With a
 * single space, a correct step 1 and one that only ever covers the default
 * space produce the same single row — and `0008`'s own step-5 coverage abort
 * reads `v_expected = v_covered` under either. Two viewers across two spaces
 * gives 4, which discriminates on both axes.
 *
 * What this file does NOT cover, deliberately: the accept path. The deleted
 * file drove `POST /invite/:token/accept` on a `0008`-written snapshot; that
 * claim is already carried by `test/integration/routes/invitation-space-assignments.test.ts`
 * (the app consumes a snapshot of this shape) plus the first case below (`0008`
 * writes exactly that shape). Reseeding it here would assert the composition by
 * hand-writing the bytes, which proves nothing the two halves do not.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const MIGRATIONS_DIR = `${REPO_ROOT}/packages/db/drizzle`;

/** The script under test. Always re-read from disk — never inlined. */
const SCRIPT = `${REPO_ROOT}/scripts/migration/0008-org-viewer-to-guest.sql`;
/** The migration that creates `space_members`, and whose section G this file slices. */
const MIGRATION_0056 = `${MIGRATIONS_DIR}/0056_space_roles.sql`;

/** One short of `0059_drop_org_viewer.sql`, which is what keeps `viewer` writable. */
const REPLAY_THROUGH = "0058_organization_deletion_reservation";

const ORG = "e0000000-0000-4000-8000-00000000d008";
const SPACE_DEFAULT = "spc_d0080000-0000-4000-8000-000000000001";
const SPACE_OTHER = "spc_d0080000-0000-4000-8000-000000000002";
const SPACE_LATER = "spc_d0080000-0000-4000-8000-000000000003";
const VIEWER_A = "usr_0008_viewer_a";
const VIEWER_B = "usr_0008_viewer_b";
const MEMBER = "usr_0008_member";

let pg: PGlite;

/**
 * Replay the journal up to and including `lastTag`, the way the Tier 0 runner
 * does (`apps/api/src/lib/pglite-migrate.ts`): whole file, breakpoints
 * stripped, one transaction each. Throws rather than stopping silently if the
 * tag is absent, so a renamed migration fails this file instead of quietly
 * replaying past the narrowing and turning every seed below into a `22P02`.
 */
async function replayThrough(db: PGlite, lastTag: string): Promise<void> {
  const journal = (await Bun.file(`${MIGRATIONS_DIR}/meta/_journal.json`).json()) as {
    entries: { idx: number; tag: string }[];
  };
  for (const entry of journal.entries) {
    const source = await Bun.file(`${MIGRATIONS_DIR}/${entry.tag}.sql`).text();
    await db.transaction(async (tx) => {
      await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
    });
    if (entry.tag === lastTag) return;
  }
  throw new Error(`journal has no entry tagged ${lastTag}`);
}

/**
 * Run an operator script (its own `BEGIN` / `COMMIT`) through the raw driver.
 *
 * A failure abandons the script before its `COMMIT` and leaves the session in
 * an aborted transaction that `25P02`s everything after it, so the rollback is
 * forced here.
 */
async function exec(sql: string): Promise<void> {
  try {
    await pg.exec(sql);
  } catch (error) {
    try {
      await pg.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    throw error;
  }
}

const runScript = async (): Promise<void> => exec(await Bun.file(SCRIPT).text());

async function count(query: string): Promise<number> {
  const { rows } = await pg.query<{ n: number | string }>(query);
  return Number(rows[0]?.n ?? -1);
}

/** One entry of a `space_assignments` / `signup_space_assignments` snapshot. */
type SpaceAssignment = { space_id: string; preset_role: string };

/** Read one jsonb value back. PGlite parses `jsonb` for us; this file only ever
 * runs on PGlite, which is why it left the integration suite. */
async function json<T = SpaceAssignment[]>(query: string): Promise<T> {
  const { rows } = await pg.query<{ v: unknown }>(query);
  return rows[0]!.v as T;
}

/**
 * The state `0056` leaves on an installation mid-rollout: two viewers and one
 * plain member in an org with two spaces, and three invitations covering the
 * statuses `0008` treats differently.
 */
async function seed(): Promise<void> {
  await exec(`
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
      ('inv_0008_pending', 'tok_0008_pending', 'p-0008@example.com', '${ORG}', 'viewer', 'pending', now() + interval '7 days'),
      ('inv_0008_expired', 'tok_0008_expired', 'e-0008@example.com', '${ORG}', 'viewer', 'expired', now() - interval '1 day'),
      ('inv_0008_member',  'tok_0008_member',  'k-0008@example.com', '${ORG}', 'member', 'pending', now() + interval '7 days');
  `);
}

beforeEach(async () => {
  pg = new PGlite();
  await replayThrough(pg, REPLAY_THROUGH);
  await seed();
  // The journal replay runs past the 15s default in `bunfig.toml` on a cold
  // machine, and an abandoned hook does not stop — it keeps replaying into an
  // instance the next run replays into again, surfacing as
  // `type "invitation_status" already exists` rather than as a timeout.
}, 300_000);

afterEach(async () => {
  await pg.close();
});

describe("scripts/migration/0008 — org `viewer` becomes `guest` + explicit space rows", () => {
  it("moves every half, and the counts discriminate", async () => {
    expect(await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'viewer'`)).toBe(2);
    expect(await count(`SELECT count(*)::int AS n FROM space_members`)).toBe(0);

    await runScript();

    // 1. Every viewer got a `viewer` row in every space that existed — the
    //    PRODUCT, not merely "more than zero", is what proves step 1 ran before
    //    step 2 erased the evidence. 2 viewers x 2 spaces = 4; a step 1 that
    //    only covered the default space would give 2.
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

    // 3. The exact bytes step 3 writes. This is the shape the accept path
    //    consumes, and asserting it here is what lets that composition rest on
    //    `invitation-space-assignments.test.ts` rather than on a case that
    //    would have to hand-write the same snapshot.
    expect(
      await json<SpaceAssignment[]>(
        `SELECT space_assignments AS v FROM org_invitations WHERE id = 'inv_0008_pending'`,
      ),
    ).toEqual([
      { space_id: SPACE_DEFAULT, preset_role: "viewer" },
      { space_id: SPACE_OTHER, preset_role: "viewer" },
    ]);

    // 4. A PENDING viewer invitation lands as a guest; a non-pending one is
    //    left to `0012` (it grants nothing, and it owes no snapshot).
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
    await runScript();
    const after = {
      spaceMembers: await count(`SELECT count(*)::int AS n FROM space_members`),
      guests: await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'guest'`),
    };

    await runScript();

    expect(await count(`SELECT count(*)::int AS n FROM space_members`)).toBe(after.spaceMembers);
    expect(await count(`SELECT count(*)::int AS n FROM org_members WHERE role = 'guest'`)).toBe(
      after.guests,
    );
  });

  it("snapshots legacy OAuth viewer signups in 0008, not 0056, and never widens on replay", async () => {
    await exec(`
      ALTER TABLE oauth_clients DROP CONSTRAINT oauth_clients_signup_role_check;
      INSERT INTO oauth_clients (id, client_id, name, level, referenced_org_id, signup_role, redirect_uris)
      VALUES ('oac_0008','oauth_0008','Legacy viewer','org','${ORG}','viewer','{}');
    `);
    const migration = await Bun.file(MIGRATION_0056).text();
    await exec(`BEGIN; ${migration.slice(migration.indexOf("-- ═══ G."))} COMMIT;`);
    const policy = () =>
      json<{ role: string; assignments: SpaceAssignment[] }>(
        `SELECT jsonb_build_object('role', signup_role, 'assignments', signup_space_assignments) AS v
           FROM oauth_clients WHERE id = 'oac_0008'`,
      );

    // `0056` carries only the write its CHECK preconditions: the role flips,
    // the snapshot stays empty. Moving the snapshot back into the migration
    // fails §2 — the column is new and defaults to `[]`, so it preconditions
    // nothing.
    expect(await policy()).toEqual({ role: "guest", assignments: [] });

    // `0008` finds the client by the pair `guest` + empty snapshot: `guest` was
    // unwritable before `0056` and the new application is not up yet.
    await runScript();
    const expected = {
      role: "guest",
      assignments: [
        { space_id: SPACE_DEFAULT, preset_role: "viewer" },
        { space_id: SPACE_OTHER, preset_role: "viewer" },
      ],
    };
    expect(await policy()).toEqual(expected);

    // A space created afterwards never joins the snapshot — the captured-set
    // design of step 4 is what makes the rerun narrow rather than widening.
    await exec(`INSERT INTO spaces (id, org_id, name) VALUES ('${SPACE_LATER}','${ORG}','Later')`);
    await runScript();
    expect(await policy()).toEqual(expected);
  });

  it("leaves an OAuth client that already carries a snapshot alone", async () => {
    await exec(`
      INSERT INTO oauth_clients (id, client_id, name, level, referenced_org_id, signup_role, signup_space_assignments, redirect_uris)
      VALUES ('oac_0008_set','oauth_0008_set','Configured guest','org','${ORG}','guest',
              '[{"space_id":"${SPACE_OTHER}","preset_role":"builder"}]'::jsonb,'{}');
    `);

    await runScript();

    expect(
      await json<SpaceAssignment[]>(
        `SELECT signup_space_assignments AS v FROM oauth_clients WHERE id = 'oac_0008_set'`,
      ),
    ).toEqual([{ space_id: SPACE_OTHER, preset_role: "builder" }]);
  });

  it("snapshots pending invitations without changing explicit choices or widening on rerun", async () => {
    await exec(
      `UPDATE org_invitations SET space_assignments = '[{"space_id":"${SPACE_OTHER}","preset_role":"builder"}]'::jsonb WHERE id = 'inv_0008_pending'`,
    );
    const snapshot = () =>
      json<SpaceAssignment[]>(
        `SELECT space_assignments AS v FROM org_invitations WHERE id = 'inv_0008_pending'`,
      );

    await runScript();

    // The explicit `builder` choice survives; only the space it does not
    // already name is added.
    expect(await snapshot()).toEqual([
      { space_id: SPACE_OTHER, preset_role: "builder" },
      { space_id: SPACE_DEFAULT, preset_role: "viewer" },
    ]);

    await exec(`INSERT INTO spaces (id, org_id, name) VALUES ('${SPACE_LATER}','${ORG}','Later')`);
    await runScript();
    expect(await snapshot()).toEqual([
      { space_id: SPACE_OTHER, preset_role: "builder" },
      { space_id: SPACE_DEFAULT, preset_role: "viewer" },
    ]);
  });

  it("leaves a hand-added row alone rather than overwriting its role", async () => {
    // An admin who already granted this person `builder` before the migration
    // keeps that decision — `ON CONFLICT DO NOTHING`, not `DO UPDATE`. This is
    // also why step 5 checks COVERAGE and not a row-count delta: the pair is
    // covered without step 1 having inserted it.
    await exec(
      `INSERT INTO space_members (space_id, user_id, preset_role)
         VALUES ('${SPACE_OTHER}', '${VIEWER_A}', 'builder');`,
    );

    await runScript();

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
