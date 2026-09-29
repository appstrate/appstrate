// SPDX-License-Identifier: Apache-2.0

/**
 * `0077_connection_sets.sql` on a database at `0076`, holding the rows it
 * exists for: scalar pins and org defaults, and connections with no label or
 * an empty one beside labels that already use the "Connexion N" series. Same
 * split as `migration-0059-drop-org-viewer.test.ts`: the replayed-journal
 * parity tests guard the shape, this file guards what the `.sql` does to rows.
 *
 * Duplicate labels and scalar snapshot values are
 * `scripts/migration/0032-connection-sets.sql`'s to rewrite
 * (`migration-script-0032-connection-sets.test.ts`); here, only that a
 * database which skipped it is refused whole.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { replayJournal } from "../helpers/journal.ts";

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../../../packages/db/drizzle");
const MIGRATION = `${MIGRATIONS_DIR}/0077_connection_sets.sql`;
const REPLAY_THROUGH = "0076_space_packages_chat_enforced";

const ORG = "e0000000-0000-4000-8000-00000000c077";
const SPACE = "spc_c0770000-0000-4000-8000-000000000001";
const ALICE = "usr_0077_alice";
const BOB = "usr_0077_bob";
const GMAIL = "@acme0077/gmail";
const SLACK = "@acme0077/slack";
const AGENT = "@acme0077/agent";

const conn = (n: number) => `c0770000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** The steps every refusal of a database that skipped the scripts names, in order. */
const NEXT_STEPS =
  "Run scripts/migration/0033-unshare-space-access-loss.ts --apply, then scripts/migration/0032-connection-sets.sql, then redeploy.";

const pg = new PGlite();

interface ApplyError {
  code?: string;
  message?: string;
}
/** What applying `0077` over each scalar snapshot or override value raised. */
const scalarErrors: (ApplyError | null)[] = [];
/** What applying `0077` over a duplicate label raised, before the real apply. */
let skippedScriptError: ApplyError | null = null;

async function applyMigration(): Promise<void> {
  const source = await Bun.file(MIGRATION).text();
  await pg.transaction(async (tx) => {
    await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
  });
}

/** The error `0077` raises on the current rows; null if it applied. */
async function applyError(): Promise<ApplyError | null> {
  try {
    await applyMigration();
    return null;
  } catch (error) {
    return error as ApplyError;
  }
}

async function labelOf(id: string): Promise<string | null> {
  const { rows } = await pg.query<{ label: string | null }>(
    "SELECT label FROM integration_connections WHERE id = $1",
    [id],
  );
  return rows[0]!.label;
}

async function rejects(sql: string): Promise<boolean> {
  try {
    await pg.exec(sql);
    return false;
  } catch {
    return true;
  }
}

beforeAll(async () => {
  await replayJournal(pg, REPLAY_THROUGH);
  const connection = (n: number, integ: string, owner: string, label: string | null, at: string) =>
    `('${conn(n)}', '${integ}', 'primary', 'acct-${n}', '${SPACE}', '${owner}', 'x', ${
      label === null ? "NULL" : `'${label}'`
    }, true, '${at}')`;
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero69', 'zero-69');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${ALICE}', 'Alice', 'a-0077@example.com', true, now(), now()),
      ('${BOB}', 'Bob', 'b-0077@example.com', true, now(), now());
    INSERT INTO packages (id, type) VALUES
      ('${GMAIL}', 'integration'), ('${SLACK}', 'integration'), ('${AGENT}', 'agent');
    INSERT INTO integration_connections
      (id, integration_package_id, auth_key, account_id, space_id, user_id,
       credentials_encrypted, label, shared_with_org, created_at)
    VALUES
      ${connection(1, GMAIL, ALICE, "Connexion 2", "2026-01-01")},
      ${connection(2, GMAIL, ALICE, null, "2026-01-02")},
      ${connection(3, GMAIL, BOB, "Connexion 5", "2026-01-03")},
      ${connection(4, GMAIL, BOB, "", "2026-01-04")},
      ${connection(5, GMAIL, ALICE, "prod", "2026-01-05")},
      ${connection(6, SLACK, ALICE, null, "2026-01-06")},
      ${connection(10, GMAIL, BOB, "Prod", "2026-01-10")},
      ${connection(11, SLACK, BOB, "prod", "2026-01-11")};
    INSERT INTO integration_pins (space_id, package_id, integration_package_id, user_id, connection_id)
      VALUES ('${SPACE}', '${AGENT}', '${GMAIL}', NULL, '${conn(1)}'),
             ('${SPACE}', '${AGENT}', '${GMAIL}', '${ALICE}', '${conn(5)}');
    INSERT INTO integration_org_defaults (space_id, integration_package_id, connection_id, enforce)
      VALUES ('${SPACE}', '${GMAIL}', '${conn(3)}', true);
    -- Sets, as 0032 leaves them: the guard lets these through.
    INSERT INTO runs
      (id, package_id, user_id, space_id, org_id, status, started_at,
       connection_overrides, resolved_connections)
    VALUES ('run_0077_set', '${AGENT}', '${ALICE}', '${SPACE}', '${ORG}', 'success', now(),
            '{"${GMAIL}": ["${conn(1)}"]}',
            '{"${GMAIL}": [{"connectionId": "${conn(1)}", "source": "member_pin"}]}');
  `);
  // A database that skipped 0032's SHAPE section: each scalar column refuses the whole batch.
  const scalarRun = (column: string, value: unknown) =>
    `INSERT INTO runs (id, package_id, user_id, space_id, org_id, status, started_at, ${column})
     VALUES ('run_0077_scalar', '${AGENT}', '${ALICE}', '${SPACE}', '${ORG}', 'success', now(),
             '${JSON.stringify({ [GMAIL]: value })}')`;
  for (const insert of [
    scalarRun("connection_overrides", conn(1)),
    scalarRun("resolved_connections", { connectionId: conn(1), source: "fallback_auto" }),
    `INSERT INTO package_schedules
       (id, package_id, user_id, org_id, space_id, cron_expression, enabled, connection_overrides)
     VALUES ('sch_0077_scalar', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', true,
             '${JSON.stringify({ [GMAIL]: conn(1) })}')`,
  ]) {
    await pg.exec(insert);
    scalarErrors.push(await applyError());
    await pg.exec(`
      DELETE FROM runs WHERE id = 'run_0077_scalar';
      DELETE FROM package_schedules WHERE id = 'sch_0077_scalar';
    `);
  }
  // A database that skipped 0032's DEDUPE section: one duplicate label refuses the whole batch.
  await pg.exec(`
    INSERT INTO integration_connections
      (id, integration_package_id, auth_key, account_id, space_id, user_id,
       credentials_encrypted, label, shared_with_org, created_at)
    VALUES ${connection(7, GMAIL, BOB, "prod", "2026-01-07")};
  `);
  skippedScriptError = await applyError();
  await pg.exec(`DELETE FROM integration_connections WHERE id = '${conn(7)}'`);
  await applyMigration();
  // A journal replay runs past the 15s default in `bunfig.toml`.
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("0077 — connection sets", () => {
  it("folds each scalar pin and org default into a one-element set", async () => {
    const pins = await pg.query<{ user_id: string | null; ids: string[] }>(
      "SELECT user_id, connection_ids::text[] AS ids FROM integration_pins ORDER BY user_id NULLS FIRST",
    );
    expect(pins.rows).toEqual([
      { user_id: null, ids: [conn(1)] },
      { user_id: ALICE, ids: [conn(5)] },
    ]);
    const defaults = await pg.query<{ ids: string[]; enforce: boolean }>(
      "SELECT connection_ids::text[] AS ids, enforce FROM integration_org_defaults",
    );
    expect(defaults.rows).toEqual([{ ids: [conn(3)], enforce: true }]);
  });

  it("numbers minted labels past the highest 'Connexion N' of the group, every owner included", async () => {
    // Alice's unlabelled row would have been "Connexion 2" under a per-owner
    // rank — a duplicate of the row beside it. Bob's "Connexion 5" sets the bar.
    expect(await labelOf(conn(2))).toBe("Connexion 6");
    expect(await labelOf(conn(4))).toBe("Connexion 7");
    // Another integration is another series.
    expect(await labelOf(conn(6))).toBe("Connexion 1");
    // Labels already set are untouched.
    expect(await labelOf(conn(1))).toBe("Connexion 2");
    expect(await labelOf(conn(5))).toBe("prod");
  });

  it("refuses, whole, a database that skipped 0032's shape rewrite, naming the scripts", () => {
    expect(scalarErrors).toHaveLength(3);
    for (const error of scalarErrors) {
      expect(error?.message).toContain(NEXT_STEPS);
    }
  });

  it("refuses, whole, a database that skipped 0032's label dedupe, naming the scripts", () => {
    // Its own guard, not the unique index's bare 23505.
    expect(skippedScriptError?.code).toBe("P0001");
    expect(skippedScriptError?.message).toContain("holds a label twice");
    expect(skippedScriptError?.message).toContain(NEXT_STEPS);
  });

  it("makes a label unique per (space, integration), verbatim", async () => {
    // The index refuses a second holder in a group …
    expect(
      await rejects(`UPDATE integration_connections SET label = 'prod' WHERE id = '${conn(10)}'`),
    ).toBe(true);
    // … while case makes another label, and another integration another group.
    expect(await labelOf(conn(10))).toBe("Prod");
    expect(await labelOf(conn(11))).toBe("prod");
    expect(
      await rejects(`UPDATE integration_connections SET label = 'Prod' WHERE id = '${conn(11)}'`),
    ).toBe(false);
  });

  it("deleting a pinned connection leaves its id in the set", async () => {
    await pg.exec(`DELETE FROM integration_connections WHERE id = '${conn(1)}'`);
    const { rows } = await pg.query<{ ids: string[] }>(
      "SELECT connection_ids::text[] AS ids FROM integration_pins WHERE user_id IS NULL",
    );
    expect(rows).toEqual([{ ids: [conn(1)] }]);
  });

  it("refuses an empty set, a set past the cap, and an empty label", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `'${conn(100 + i)}'`).join(",");
    const pin = (ids: string) =>
      `UPDATE integration_pins SET connection_ids = ${ids} WHERE user_id IS NULL`;
    expect(await rejects(pin("ARRAY[]::uuid[]"))).toBe(true);
    expect(await rejects(pin(`ARRAY[${ids(MAX_CONNECTIONS_PER_INTEGRATION + 1)}]::uuid[]`))).toBe(
      true,
    );
    expect(
      await rejects(`UPDATE integration_connections SET label = '' WHERE id = '${conn(5)}'`),
    ).toBe(true);
    // Control: a set at the cap and a real label land.
    expect(await rejects(pin(`ARRAY[${ids(MAX_CONNECTIONS_PER_INTEGRATION)}]::uuid[]`))).toBe(
      false,
    );
    expect(
      await rejects(`UPDATE integration_connections SET label = 'staging' WHERE id = '${conn(5)}'`),
    ).toBe(false);
  });

  it("drops the scalar column and keeps one row per pin key", async () => {
    const { rows } = await pg.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name IN ('integration_pins', 'integration_org_defaults')
         AND column_name = 'connection_id'`,
    );
    expect(rows).toEqual([]);
    expect(
      await rejects(
        `INSERT INTO integration_pins (space_id, package_id, integration_package_id, connection_ids)
         VALUES ('${SPACE}', '${AGENT}', '${GMAIL}', ARRAY['${conn(2)}']::uuid[])`,
      ),
    ).toBe(true);
  });
});
