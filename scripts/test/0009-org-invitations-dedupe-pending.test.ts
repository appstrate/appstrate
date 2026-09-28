// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0009-org-invitations-dedupe-pending.sql` — replayed
 * against a database one migration short of `0056_space_roles.sql`, which is
 * the only place the fixture is seedable: `uq_org_invitations_pending` is the
 * index the script exists to make creatable, and it refuses the duplicate the
 * script repairs.
 *
 * Why this file exists at all. `0009` is the one conditional pre-requisite of
 * the `0056` batch with no test and — unlike `0016` — no `DO $$ … RAISE` of its
 * own, so its whole verification is a `SELECT … duplicate_pairs_after` the
 * runbook asks an operator to eyeball. That number does not DISCRIMINATE: it is
 * the count of pairs holding MORE THAN ONE pending row, so it reads `0` both
 * when the script cancelled exactly the older siblings and when it cancelled
 * every pending invitation in the deployment. The self-join is one character
 * away from the second — `(older.created_at, older.id) < (…)` widened to `<=`
 * matches every row against ITSELF — and against real data (beta.57) that
 * silently cancels every outstanding invitation in every organization, whose
 * links then answer 410 with nobody the wiser until an invitee complains.
 *
 * So the load-bearing case here is not the repair, it is the NEGATIVE control:
 * the single pending invitation that must come out the other side untouched —
 * in an organization that has no duplicate at all, and in the one that does.
 *
 * A fresh PGlite per case: the script is globally scoped (no org filter), so
 * cases cannot be isolated by using disjoint organizations inside one instance.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { replayJournal } from "../../apps/api/test/helpers/journal.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const MIGRATIONS_DIR = `${REPO_ROOT}/packages/db/drizzle`;

/** The script under test. Always re-read from disk — never inlined. */
const SCRIPT = `${REPO_ROOT}/scripts/migration/0009-org-invitations-dedupe-pending.sql`;
/** The batch whose narrowing the script clears the way for. */
const MIGRATION_0056 = `${MIGRATIONS_DIR}/0056_space_roles.sql`;

/** One short of `0056`, which is what keeps the duplicate seedable. */
const REPLAY_THROUGH = "0055_schema_integrity_repairs";

/** The organization holding the duplicate pair the script repairs. */
const ORG_DUP = "e0000000-0000-4000-8000-000000000091";
/** An organization with ONE pending invitation and no duplicate anywhere. */
const ORG_SOLO = "e0000000-0000-4000-8000-000000000092";
/** A third organization inviting the SAME address — a different pair entirely. */
const ORG_OTHER = "e0000000-0000-4000-8000-000000000093";

/** The contested address: three pending rows in `ORG_DUP`, one in `ORG_OTHER`. */
const DUP_EMAIL = "dup@example.com";

const OLDEST = "inv_0009_oldest";
const MIDDLE = "inv_0009_middle";
const NEWEST = "inv_0009_newest";
/** Already accepted, same pair — outside the `status = 'pending'` predicate. */
const ACCEPTED = "inv_0009_accepted";
/** `ORG_DUP`'s other invitee: a single pending row inside the repaired org. */
const DUP_ORG_SOLO = "inv_0009_dup_org_solo";
/** The whole-organization control: `ORG_SOLO` holds this one row and nothing else. */
const SOLO = "inv_0009_solo";
/** `ORG_OTHER`'s pending row for `DUP_EMAIL` — same address, different pair. */
const OTHER_ORG = "inv_0009_other_org";

let pg: PGlite;

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

/**
 * The ONE statement of the `0056` batch this script exists for, lifted from the
 * batch file rather than retyped: a test that asserts against its own copy of
 * the index proves nothing about the migration the operator will actually run.
 */
async function createUniqueIndex(): Promise<void> {
  const source = await Bun.file(MIGRATION_0056).text();
  const statement = source
    .split("\n")
    .find(
      (line) => line.includes("CREATE UNIQUE INDEX") && line.includes("uq_org_invitations_pending"),
    );
  if (!statement) {
    throw new Error(`${MIGRATION_0056} no longer creates uq_org_invitations_pending`);
  }
  await exec(statement.replace("--> statement-breakpoint", ""));
}

/** Every invitation's status, keyed by id — the whole observable outcome. */
async function statuses(): Promise<Record<string, string>> {
  const { rows } = await pg.query<{ id: string; status: string }>(
    `SELECT id, status FROM org_invitations ORDER BY id`,
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

/**
 * The state `0056` refuses, plus every row that must survive it:
 *
 *  - `ORG_DUP` + `DUP_EMAIL` — three pending rows, ages apart, and an
 *    `accepted` fourth the partial index does not see;
 *  - `ORG_DUP` + another address — a single pending row INSIDE the repaired
 *    organization, so "touched nothing else" is asserted where the UPDATE runs;
 *  - `ORG_SOLO` — an organization whose only invitation is pending, the shape
 *    the overwhelming majority of deployments are made of;
 *  - `ORG_OTHER` + `DUP_EMAIL` — the same address in another organization, so
 *    the pair really is `(org_id, email)` and not `email`.
 */
async function seed(): Promise<void> {
  await exec(`
    INSERT INTO organizations (id, name, slug) VALUES
      ('${ORG_DUP}',   'Dup Org',   'dup-org-0009'),
      ('${ORG_SOLO}',  'Solo Org',  'solo-org-0009'),
      ('${ORG_OTHER}', 'Other Org', 'other-org-0009');
    INSERT INTO org_invitations (id, token, email, org_id, role, status, expires_at, created_at) VALUES
      ('${OLDEST}',       'tok_0009_oldest',   '${DUP_EMAIL}',        '${ORG_DUP}',   'member', 'pending',  now() + interval '7 days', now() - interval '3 days'),
      ('${MIDDLE}',       'tok_0009_middle',   '${DUP_EMAIL}',        '${ORG_DUP}',   'member', 'pending',  now() + interval '7 days', now() - interval '2 days'),
      ('${NEWEST}',       'tok_0009_newest',   '${DUP_EMAIL}',        '${ORG_DUP}',   'member', 'pending',  now() + interval '7 days', now() - interval '1 day'),
      ('${ACCEPTED}',     'tok_0009_accepted', '${DUP_EMAIL}',        '${ORG_DUP}',   'member', 'accepted', now() + interval '7 days', now() - interval '9 days'),
      ('${DUP_ORG_SOLO}', 'tok_0009_dupsolo',  'other@example.com',   '${ORG_DUP}',   'member', 'pending',  now() + interval '7 days', now() - interval '4 days'),
      ('${SOLO}',         'tok_0009_solo',     'solo@example.com',    '${ORG_SOLO}',  'member', 'pending',  now() + interval '7 days', now() - interval '5 days'),
      ('${OTHER_ORG}',    'tok_0009_other',    '${DUP_EMAIL}',        '${ORG_OTHER}', 'member', 'pending',  now() + interval '7 days', now() - interval '6 days');
  `);
}

beforeEach(async () => {
  pg = new PGlite();
  await replayJournal(pg, REPLAY_THROUGH);
  await seed();
  // The journal replay runs past the 15s default in `bunfig.toml` on a cold
  // machine, and an abandoned hook keeps replaying into an instance the next
  // run replays into again.
}, 300_000);

afterEach(async () => {
  await pg.close();
});

describe("scripts/migration/0009 — one pending invitation per (org, email)", () => {
  it("keeps the NEWEST pending row of the pair and cancels the older ones", async () => {
    // The fixture is the state `0056` refuses — assert that before repairing it,
    // so a passing repair cannot be a fixture that never held a duplicate.
    await expect(createUniqueIndex()).rejects.toThrow(/could not create unique index/i);

    await runScript();

    expect(await statuses()).toEqual({
      // The pair: the last link shared survives, its two predecessors are
      // cancelled. Nothing is deleted — the history stays readable.
      [NEWEST]: "pending",
      [MIDDLE]: "cancelled",
      [OLDEST]: "cancelled",
      // Outside `status = 'pending'` on both sides of the join, and outside the
      // partial index: an accepted invitation is not a duplicate of anything.
      [ACCEPTED]: "accepted",
      // …and nothing else moved. Spelled as the WHOLE table rather than as
      // three lookups: a script that over-reaches is caught by the rows it was
      // never asked about, which is exactly how the `<=` defect presents.
      [DUP_ORG_SOLO]: "pending",
      [SOLO]: "pending",
      [OTHER_ORG]: "pending",
    });

    // And the narrowing the whole exercise is for now applies.
    await createUniqueIndex();
  });

  it("leaves a lone pending invitation alone — in its own org and in the repaired one", async () => {
    // THE control. `duplicate_pairs_after` — the number the runbook has the
    // operator read — is `0` whether the script cancelled the older siblings or
    // cancelled every pending row there is, so it cannot tell a repair from a
    // wipe. This can: widen the self-join's `<` to `<=` and each of these three
    // rows matches ITSELF, comes out `cancelled`, and the printed verdict still
    // says the pre-flight succeeded.
    await runScript();

    const after = await statuses();
    expect(after[SOLO]).toBe("pending");
    expect(after[DUP_ORG_SOLO]).toBe("pending");
    expect(after[OTHER_ORG]).toBe("pending");
    // The survivor of the repaired pair is the same kind of row and answers the
    // same way: one pending invitation per pair, still usable.
    expect(after[NEWEST]).toBe("pending");
    const { rows } = await pg.query<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM org_invitations WHERE status = 'pending'`,
    );
    expect(Number(rows[0]!.n), "four pending rows in, four pending rows out").toBe(4);
  });

  it("does not touch another organization's invitation to the SAME address", async () => {
    // The pair is `(org_id, email)`. Dropping `older.org_id = newer.org_id`
    // makes one organization's second invite cancel another's, across tenants —
    // and `duplicate_pairs_after` reads `0` for that too.
    await runScript();

    const after = await statuses();
    expect(after[OTHER_ORG]).toBe("pending");

    // Discriminating, and stated as a property of the FIXTURE: `ORG_OTHER`'s
    // row is older than every row of the repaired pair, so it is one a
    // cross-tenant join would have cancelled — the assertion above is a real
    // refusal, not a row the join could never have reached anyway.
    const { rows } = await pg.query<{ id: string }>(
      `SELECT id FROM org_invitations
       WHERE id IN ('${OTHER_ORG}', '${OLDEST}', '${MIDDLE}', '${NEWEST}')
       ORDER BY created_at, id`,
    );
    expect(rows.map((row) => row.id)[0]).toBe(OTHER_ORG);
  });

  it("is idempotent — a second run changes nothing", async () => {
    await runScript();
    const afterFirst = await statuses();

    await runScript();

    expect(await statuses()).toEqual(afterFirst);
    // Stated as the script's own verdict too, since that is the line the
    // operator reads: no pair holds more than one pending row.
    const { rows } = await pg.query<{ n: number | string }>(`
      SELECT count(*)::int AS n FROM (
        SELECT org_id, email FROM org_invitations
        WHERE status = 'pending' GROUP BY org_id, email HAVING count(*) > 1
      ) d
    `);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
