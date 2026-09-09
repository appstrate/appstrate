// SPDX-License-Identifier: Apache-2.0

/**
 * `0059_drop_org_viewer.sql` on a database that still HAS the state it exists
 * for — and refuses to run against one whose rows have not moved.
 *
 * The split with `migration-schema-parity.test.ts` is the one
 * `migration-0055-schema-repairs.test.ts` describes. That file replays the
 * whole journal and asserts the resulting enum is `ORG_ROLES`; it guards the
 * INVARIANT, and it is green on a fresh install where the two tables are empty
 * and the type swap has nothing to carry. This file builds the population the
 * migration was written for — an installation mid-RBAC-rollout, with `viewer`
 * rows of three different kinds — and checks what the shipped `.sql` does to
 * it.
 *
 * ═══ THE SUBJECT IS A DATABASE AT `0058`, NOT A FRESH ONE ═══
 *
 * The journal is replayed only as far as `0058`, because `0059` is the first
 * migration in this repo whose behaviour depends on ROWS. Stopping there is
 * what makes `org_role` still carry `viewer` — the state every real database is
 * in the moment before this migration runs — and lets the seed write values
 * `ORG_ROLES` can no longer express.
 *
 * ═══ ONE DATABASE, READ IN ORDER ═══
 *
 * The `it`s below share a single instance and run as a sequence, deliberately:
 * "`0012` alone is not enough" is a claim about an ORDER, and no single state
 * expresses it. One instance is also what keeps the file cheap — a journal
 * replay is what every test in this directory pays for, and this one pays once.
 *
 * The seed is what `0056` leaves behind, plus one row it could not leave: an
 * OAuth client whose `signup_role` reads `viewer`, which `0056` made unwritable
 * when it narrowed `oauth_clients_signup_role_check`. The CHECK is lifted to
 * write it, because that is the only way to exercise the guard's fourth arm —
 * the arm that fires exactly when `0056`'s own section-G write did not happen —
 * and the sequence then repairs the row the way `0056` would have.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ORG_ROLES } from "@appstrate/core/permissions";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const MIGRATIONS_DIR = `${REPO_ROOT}/packages/db/drizzle`;

/** The migration under test. Always re-read from disk — never inlined. */
const MIGRATION = `${MIGRATIONS_DIR}/0059_drop_org_viewer.sql`;
/** The two row scripts its guard names, likewise read from disk. */
const SCRIPT_0008 = `${REPO_ROOT}/scripts/migration/0008-org-viewer-to-guest.sql`;
const SCRIPT_0012 = `${REPO_ROOT}/scripts/migration/0012-org-invitation-history-viewer-to-guest.sql`;

/** The last migration before the one under test. */
const REPLAY_THROUGH = "0058_organization_deletion_reservation";

const ORG = "e0000000-0000-4000-8000-00000000d059";
const SPACE = "spc_d0590000-0000-4000-8000-000000000001";
const VIEWER = "usr_0059_viewer";
const MEMBER = "usr_0059_member";

const pg = new PGlite();

/**
 * Replay the journal up to and including `lastTag`, the way the Tier 0 runner
 * does (`apps/api/src/lib/pglite-migrate.ts`): whole file, breakpoints
 * stripped, one transaction each. Throws rather than stopping silently if the
 * tag is absent, so a renamed migration fails this file instead of quietly
 * shortening the replay.
 */
async function replayThrough(pg: PGlite, lastTag: string): Promise<void> {
  const journal = (await Bun.file(`${MIGRATIONS_DIR}/meta/_journal.json`).json()) as {
    entries: { idx: number; tag: string }[];
  };
  for (const entry of journal.entries) {
    const source = await Bun.file(`${MIGRATIONS_DIR}/${entry.tag}.sql`).text();
    await pg.transaction(async (tx) => {
      await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
    });
    if (entry.tag === lastTag) return;
  }
  throw new Error(`journal has no entry tagged ${lastTag}`);
}

/**
 * Apply `0059` the way the runner does. The transaction is not decoration: the
 * `SET LOCAL` fences are no-ops outside one, and — more importantly — a guard
 * that raises must take the whole file's DDL down with it, which is what the
 * "leaves the type alone" assertions below actually check.
 */
async function applyMigration(pg: PGlite): Promise<void> {
  const source = await Bun.file(MIGRATION).text();
  await pg.transaction(async (tx) => {
    await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
  });
}

/**
 * Run an operator script (its own `BEGIN` / `COMMIT`) through the raw driver.
 *
 * A failure abandons the script before its `COMMIT` and leaves the session in
 * an aborted transaction that `25P02`s everything after it, so the rollback is
 * forced here — same helper, same reason, as
 * `test/integration/db/org-viewer-to-guest-migration.test.ts`.
 */
async function runScript(pg: PGlite, path: string): Promise<void> {
  const source = await Bun.file(path).text();
  try {
    await pg.exec(source);
  } catch (error) {
    try {
      await pg.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    throw error;
  }
}

/** Labels of the `org_role` type, in `enumsortorder`. */
async function orgRoleLabels(pg: PGlite): Promise<string[]> {
  const { rows } = await pg.query<{ enumlabel: string }>(
    `SELECT e.enumlabel::text AS enumlabel
     FROM pg_enum e
     JOIN pg_type t ON t.oid = e.enumtypid
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = 'org_role'
     ORDER BY e.enumsortorder`,
  );
  return rows.map((row) => row.enumlabel);
}

/** Every `org_role`-shaped type in `public`, so a leftover shows up by name. */
async function orgRoleTypeNames(pg: PGlite): Promise<string[]> {
  const { rows } = await pg.query<{ typname: string }>(
    `SELECT t.typname
     FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname LIKE 'org\\_role%'
     ORDER BY t.typname`,
  );
  return rows.map((row) => row.typname);
}

async function count(pg: PGlite, query: string): Promise<number> {
  const { rows } = await pg.query<{ n: number | string }>(query);
  return Number(rows[0]?.n ?? -1);
}

/** `role` of one invitation, read as text so it survives the type swap. */
async function invitationRole(pg: PGlite, id: string): Promise<string | undefined> {
  const { rows } = await pg.query<{ role: string }>(
    "SELECT role::text AS role FROM org_invitations WHERE id = $1",
    [id],
  );
  return rows[0]?.role;
}

async function memberRole(pg: PGlite, userId: string): Promise<string | undefined> {
  const { rows } = await pg.query<{ role: string }>(
    "SELECT role::text AS role FROM org_members WHERE user_id = $1",
    [userId],
  );
  return rows[0]?.role;
}

/**
 * The population `0056` leaves behind on a real installation: two org members
 * (one `viewer`), four invitations covering every status the rollout treats
 * differently, and the OAuth signup client `0056` has already flipped to
 * `guest` — plus the stale one it could not have left, see the header.
 */
async function seedRollout(pg: PGlite): Promise<void> {
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero59', 'zero-59');
    INSERT INTO spaces (id, org_id, name, is_default)
      VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${VIEWER}', 'Viewer', 'v-0059@example.com', true, now(), now()),
      ('${MEMBER}', 'Member', 'm-0059@example.com', true, now(), now());
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('${ORG}', '${VIEWER}', 'viewer'),
      ('${ORG}', '${MEMBER}', 'member');
    INSERT INTO org_invitations (id, token, email, org_id, role, status, expires_at) VALUES
      ('inv_0059_pending',   'tok_0059_pending',   'p-0059@example.com', '${ORG}', 'viewer', 'pending',   now() + interval '7 days'),
      ('inv_0059_accepted',  'tok_0059_accepted',  'a-0059@example.com', '${ORG}', 'viewer', 'accepted',  now() + interval '7 days'),
      ('inv_0059_cancelled', 'tok_0059_cancelled', 'c-0059@example.com', '${ORG}', 'viewer', 'cancelled', now() - interval '1 day'),
      ('inv_0059_member',    'tok_0059_member',    'k-0059@example.com', '${ORG}', 'member', 'pending',   now() + interval '7 days');
    INSERT INTO oauth_clients (id, client_id, redirect_uris, level, allow_signup, signup_role)
      VALUES ('oc_0059', 'cid_0059', '{}', 'instance', true, 'guest');
  `);
  await pg.exec(`
    ALTER TABLE oauth_clients DROP CONSTRAINT oauth_clients_signup_role_check;
    INSERT INTO oauth_clients (id, client_id, redirect_uris, level, allow_signup, signup_role)
      VALUES ('oc_0059_stale', 'cid_0059_stale', '{}', 'instance', true, 'viewer');
    ALTER TABLE oauth_clients ADD CONSTRAINT oauth_clients_signup_role_check
      CHECK (signup_role IN ('admin', 'member', 'guest')) NOT VALID;
  `);
}

beforeAll(async () => {
  await replayThrough(pg, REPLAY_THROUGH);
  await seedRollout(pg);
  // A journal replay is the expensive part of every test in this directory, and
  // it runs past the 15s default in `bunfig.toml`. An abandoned `beforeAll`
  // does not stop — it keeps replaying into an instance the next hook run then
  // replays into AGAIN, which surfaces as
  // `type "invitation_status" already exists` rather than as a timeout, so the
  // budget is stated rather than left to chance.
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("0059 — the RBAC rollout must have happened first", () => {
  it("starts from a database that still carries `viewer`", async () => {
    // Fixture guard. Every refusal below is evidence only if the type really
    // still holds the value and the seed really wrote it — a replay that
    // silently ran `0059` too would make the next case vacuously green.
    expect(await orgRoleLabels(pg)).toEqual(["owner", "admin", "member", "viewer", "guest"]);
    expect(
      await count(pg, "SELECT count(*)::int AS n FROM org_members WHERE role = 'viewer'"),
    ).toBe(1);
    expect(
      await count(pg, "SELECT count(*)::int AS n FROM org_invitations WHERE role = 'viewer'"),
    ).toBe(3);
  });

  it("refuses the deploy, counting each set and naming both scripts", async () => {
    const failure = await applyMigration(pg).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeDefined();
    const message = `${failure?.message ?? ""}`;

    // The counts are the operator's go/no-go, so they are asserted
    // individually: a message that said "some rows" would pass a
    // `toThrow(/viewer/)` and tell nobody which half is missing.
    expect(message).toContain("1 viewer member(s)");
    expect(message).toContain("1 pending viewer invitation(s)");
    expect(message).toContain("2 historical viewer invitation(s)");
    expect(message).toContain("1 viewer signup client(s)");

    // And the remedy. `0059` is not deployable on its own, so an error that
    // does not name the two scripts is an error nobody can act on.
    expect(message).toContain("0008-org-viewer-to-guest.sql");
    expect(message).toContain("0012-org-invitation-history-viewer-to-guest.sql");
  });

  it("leaves the type and the rows exactly as they were when it refuses", async () => {
    // The half that makes the refusal safe rather than merely loud: section B
    // runs after section A in the same transaction, so a guard that raised
    // without taking the DDL with it would leave a database whose columns had
    // moved onto a type its rows cannot express.
    expect(await orgRoleLabels(pg)).toEqual(["owner", "admin", "member", "viewer", "guest"]);
    expect(await orgRoleTypeNames(pg)).toEqual(["org_role"]);
    expect(await memberRole(pg, VIEWER)).toBe("viewer");
    expect(await invitationRole(pg, "inv_0059_accepted")).toBe("viewer");
  });

  it("counts the signup clients `0056` should have flipped, and stops once repaired", async () => {
    // The guard's fourth arm. A `viewer` here means
    // `oauth_clients_signup_role_check` is not narrowed — `0056` section G did
    // not run — and provisioning a signup would mint an org member holding a
    // role the type is about to lose. The repair below IS that write, replayed
    // by hand, and it is what takes the count to 0.
    await pg.exec("UPDATE oauth_clients SET signup_role = 'guest' WHERE signup_role = 'viewer'");

    const failure = await applyMigration(pg).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    const message = `${failure?.message ?? ""}`;
    expect(message).toContain("0 viewer signup client(s)");
    // Still refused, on the three arms the two scripts own — the client was
    // never the only thing standing in the way.
    expect(message).toContain("1 viewer member(s)");
  });

  it("`0012` moves the historical invitations and nothing else, twice over", async () => {
    // Run TWICE: `0012`'s WHERE is exactly the condition it removes, so the
    // second pass must match zero rows. Both runs happen here, before `0008`
    // and before the migration, which is the only window in which the script
    // is runnable at all — after the narrowing its `role = 'viewer'` literal
    // no longer parses, the same way `0008`'s does not.
    await runScript(pg, SCRIPT_0012);
    const afterFirst = await count(
      pg,
      "SELECT count(*)::int AS n FROM org_invitations WHERE role::text = 'guest'",
    );
    await runScript(pg, SCRIPT_0012);
    expect(
      await count(pg, "SELECT count(*)::int AS n FROM org_invitations WHERE role::text = 'guest'"),
    ).toBe(afterFirst);

    // Accepted and cancelled: history, rewritten to the successor value.
    expect(await invitationRole(pg, "inv_0059_accepted")).toBe("guest");
    expect(await invitationRole(pg, "inv_0059_cancelled")).toBe("guest");
    // Pending: `0008`'s, because it owes a `space_assignments` snapshot that
    // `0012` does not write. This is the assertion that fails if `0012`'s
    // `status <> 'pending'` is ever widened.
    expect(await invitationRole(pg, "inv_0059_pending")).toBe("viewer");
    expect(
      await count(
        pg,
        `SELECT jsonb_array_length(space_assignments)::int AS n
         FROM org_invitations WHERE id = 'inv_0059_pending'`,
      ),
    ).toBe(0);
    // Untouched: neither script has an opinion about a non-viewer row.
    expect(await invitationRole(pg, "inv_0059_member")).toBe("member");
    expect(await memberRole(pg, VIEWER)).toBe("viewer");
  });

  it("still refuses after `0012` alone — the members are `0008`'s half", async () => {
    const failure = await applyMigration(pg).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    const message = `${failure?.message ?? ""}`;
    // The two counts `0012` cleared now read 0, and the two it does not own
    // still do not. Running the scripts in either order is fine; running only
    // one of them is not, and this is what says so.
    expect(message).toContain("1 viewer member(s)");
    expect(message).toContain("1 pending viewer invitation(s)");
    expect(message).toContain("0 historical viewer invitation(s)");
  });

  it("applies once `0008` has run too, and narrows the type", async () => {
    await runScript(pg, SCRIPT_0008);

    // `0008`'s own discriminating claim, asserted HERE because this file is the
    // last place it can be: once the migration below has run, no database built
    // from the journal can hold the `viewer` the script moves, so
    // `test/integration/db/org-viewer-to-guest-migration.test.ts` — which seeds
    // that value against the suite's shared database — has no reachable subject
    // and is deleted in this change. The reach a viewer had is preserved as an
    // explicit row per space that existed, which is what "0 viewers left" alone
    // would not distinguish from "there were never any".
    expect(
      await count(
        pg,
        `SELECT count(*)::int AS n FROM space_members
           WHERE user_id = '${VIEWER}' AND space_id = '${SPACE}' AND preset_role = 'viewer'`,
      ),
    ).toBe(1);
    // The plain member got none: they reach the open space implicitly.
    expect(
      await count(pg, `SELECT count(*)::int AS n FROM space_members WHERE user_id = '${MEMBER}'`),
    ).toBe(0);
    // And the pending invitation carries the snapshot that makes its acceptance
    // equivalent — the one `0012` must never write.
    expect(
      await count(
        pg,
        `SELECT jsonb_array_length(space_assignments)::int AS n
           FROM org_invitations WHERE id = 'inv_0059_pending'`,
      ),
    ).toBe(1);

    await applyMigration(pg);

    // The point of the whole file: the database's vocabulary is now the code's,
    // in the code's order — `enumsortorder` is what `ORDER BY role` resolves
    // against, so the order is part of the claim.
    expect(await orgRoleLabels(pg)).toEqual([...ORG_ROLES]);
    // And the old type is gone rather than orphaned under its working name.
    expect(await orgRoleTypeNames(pg)).toEqual(["org_role"]);
  });

  it("carries every surviving value across the swap", async () => {
    // A type swap that lost or shuffled a value would still satisfy the label
    // assertions above. The rows are what say it did not.
    expect(await memberRole(pg, VIEWER)).toBe("guest"); // moved by `0008`
    expect(await memberRole(pg, MEMBER)).toBe("member"); // untouched throughout
    expect(await invitationRole(pg, "inv_0059_pending")).toBe("guest"); // `0008`
    expect(await invitationRole(pg, "inv_0059_accepted")).toBe("guest"); // `0012`
    expect(await invitationRole(pg, "inv_0059_cancelled")).toBe("guest"); // `0012`
    expect(await invitationRole(pg, "inv_0059_member")).toBe("member");

    // The columns are on the NEW type under the declared name, still NOT NULL:
    // `ALTER COLUMN … TYPE` is the one statement that could have dropped either
    // property without failing.
    const { rows } = await pg.query<{ table_name: string; ty: string; notnull: boolean }>(
      `SELECT c.relname AS table_name, a.atttypid::regtype::text AS ty, a.attnotnull AS notnull
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND a.attname = 'role'
         AND c.relname IN ('org_members', 'org_invitations')
       ORDER BY c.relname`,
    );
    expect(rows).toEqual([
      { table_name: "org_invitations", ty: "org_role", notnull: true },
      { table_name: "org_members", ty: "org_role", notnull: true },
    ]);
  });

  it("makes `viewer` unwritable", async () => {
    // The narrowing has to be enforced by the TYPE, not merely absent from the
    // catalog listing: this is the property the whole migration buys, and the
    // reason `packages/core`'s `ORG_ROLES` can be trusted as the closed set.
    const failure = await pg
      .query(
        `INSERT INTO org_members (org_id, user_id, role)
         VALUES ('${ORG}', '${MEMBER}', 'viewer')`,
      )
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );
    expect(`${failure?.message ?? ""}`).toContain("viewer");
  });

  it("is a no-op on a database it has already converged", async () => {
    // Two properties at once, and the second is the subtle one:
    //
    //   * section B's label check makes the swap idempotent;
    //   * section A survives the narrowing. Its comparisons are `role::text =
    //     'viewer'`, and a guard written the natural way — `role = 'viewer'` —
    //     would raise `22P02 invalid input value for enum org_role: "viewer"`
    //     right here, turning the file into one that can never be replayed.
    await applyMigration(pg);

    expect(await orgRoleLabels(pg)).toEqual([...ORG_ROLES]);
    expect(await orgRoleTypeNames(pg)).toEqual(["org_role"]);
    expect(await memberRole(pg, VIEWER)).toBe("guest");
  });
});
