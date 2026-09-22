// SPDX-License-Identifier: Apache-2.0

/**
 * `0069_connection_sets.sql` on a database at `0068`, holding the rows it
 * exists for: scalar pins and org defaults, and connections with no label or
 * an empty one beside labels that already use the "Connexion N" series.
 * Same split as `migration-0059-drop-org-viewer.test.ts`: the replayed-journal
 * parity tests guard the shape, this file guards what the `.sql` does to rows.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = resolve(import.meta.dir, "../../../../packages/db/drizzle");
const MIGRATION = `${MIGRATIONS_DIR}/0069_connection_sets.sql`;
const REPLAY_THROUGH = "0068_packages_org_home_validate";

const ORG = "e0000000-0000-4000-8000-00000000c069";
const SPACE = "spc_c0690000-0000-4000-8000-000000000001";
const ALICE = "usr_0069_alice";
const BOB = "usr_0069_bob";
const GMAIL = "@acme0069/gmail";
const SLACK = "@acme0069/slack";
const AGENT = "@acme0069/agent";

const conn = (n: number) => `c0690000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const pg = new PGlite();

async function replayThrough(lastTag: string): Promise<void> {
  const journal = (await Bun.file(`${MIGRATIONS_DIR}/meta/_journal.json`).json()) as {
    entries: { tag: string }[];
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
  await replayThrough(REPLAY_THROUGH);
  const connection = (n: number, integ: string, owner: string, label: string | null, at: string) =>
    `('${conn(n)}', '${integ}', 'primary', 'acct-${n}', '${SPACE}', '${owner}', 'x', ${
      label === null ? "NULL" : `'${label}'`
    }, true, '${at}')`;
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero69', 'zero-69');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${ALICE}', 'Alice', 'a-0069@example.com', true, now(), now()),
      ('${BOB}', 'Bob', 'b-0069@example.com', true, now(), now());
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
      ${connection(6, SLACK, ALICE, null, "2026-01-06")};
    INSERT INTO integration_pins (space_id, package_id, integration_package_id, user_id, connection_id)
      VALUES ('${SPACE}', '${AGENT}', '${GMAIL}', NULL, '${conn(1)}'),
             ('${SPACE}', '${AGENT}', '${GMAIL}', '${ALICE}', '${conn(5)}');
    INSERT INTO integration_org_defaults (space_id, integration_package_id, connection_id, enforce)
      VALUES ('${SPACE}', '${GMAIL}', '${conn(3)}', true);
  `);
  await pg.transaction(async (tx) => {
    const source = await Bun.file(MIGRATION).text();
    await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
  });
  // A journal replay runs past the 15s default in `bunfig.toml`.
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("0069 — connection sets", () => {
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

  it("deleting a pinned connection leaves its id in the set", async () => {
    await pg.exec(`DELETE FROM integration_connections WHERE id = '${conn(1)}'`);
    const { rows } = await pg.query<{ ids: string[] }>(
      "SELECT connection_ids::text[] AS ids FROM integration_pins WHERE user_id IS NULL",
    );
    expect(rows).toEqual([{ ids: [conn(1)] }]);
  });

  it("refuses an empty set, a set past the cap, and an empty label", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `'${conn(100 + i)}'`).join(",");
    const pin = (ids: string) =>
      `UPDATE integration_pins SET connection_ids = ${ids} WHERE user_id IS NULL`;
    expect(await rejects(pin("ARRAY[]::uuid[]"))).toBe(true);
    expect(await rejects(pin(`ARRAY[${eleven}]::uuid[]`))).toBe(true);
    expect(
      await rejects(`UPDATE integration_connections SET label = '' WHERE id = '${conn(5)}'`),
    ).toBe(true);
    // Control: a set of two and a real label land.
    expect(await rejects(pin(`ARRAY['${conn(1)}', '${conn(2)}']::uuid[]`))).toBe(false);
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
