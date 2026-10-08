// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0036-unshare-end-user-connections.sql` on a private PGlite replayed to
 * `0079` — the schema it runs against, one migration short of `0080`, which is also the only
 * place a shared end user's connection is seedable. The script runs twice, then `0080` lands on
 * top. Each branch of `0080`'s guard is proven alone, on a database holding only that state.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { journalPGlite } from "../helpers/journal.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = `${REPO_ROOT}/scripts/migration/0036-unshare-end-user-connections.sql`;
const MIGRATION_0080 = `${REPO_ROOT}/packages/db/drizzle/0080_integration_connections_end_user_not_shared.sql`;
const REPLAY_THROUGH = "0079_connection_set_cap_20";

const ORG = "e0000000-0000-4000-8000-00000000d036";
const SPACE = "spc_d0360000-0000-4000-8000-000000000001";
const ALICE = "usr_0036_alice";
const ERIN = "eu_0036_erin";
const GMAIL = "@acme0036/gmail";
const SLACK = "@acme0036/slack";
const AGENT = "@acme0036/agent";
const AGENT_2 = "@acme0036/agent-2";
const AGENT_3 = "@acme0036/agent-3";

const conn = (n: number) => `d0360000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Alice's, shared: every set keeps it. */
const ALICE_SHARED = conn(1);
const ALICE_SHARED_2 = conn(2);
/** Erin's, shared: in a two-id admin pin, a three-id default, Alice's member pin and schedule. */
const ERIN_SHARED = conn(3);
/** Erin's, shared: alone in an admin pin. */
const ERIN_PINNED_ALONE = conn(4);
/** Erin's, never shared, named nowhere. */
const ERIN_PRIVATE = conn(5);
/** Erin's, shared: alone in an org default. */
const ERIN_DEFAULT_ALONE = conn(6);
/** Erin's, never shared, beside a dangling id in an admin pin. */
const ERIN_UNSHARED_PINNED = conn(7);
/** No connection row: an id a deleted connection left in an admin pin. */
const DEAD = conn(99);

let pg: PGlite;
let afterFirstRun = "";
let afterSecondRun = "";
let firstRun: ScriptOutput;
let secondRun: ScriptOutput;

interface ScriptOutput {
  counts: Record<string, number>;
  unshared: { unshared_connection_id: string; space_id: string; end_user_id: string }[];
  /** The pins and defaults the script announces it rewrites or deletes. */
  listed: {
    kind: string;
    org_id: string;
    space_id: string;
    agent_id: string | null;
    integration_package_id: string;
    connection_ids_before: string;
  }[];
}

/** The one-row count lines the script prints, merged, and the rows it lists. */
async function runScript(db: PGlite): Promise<ScriptOutput> {
  const results = await db.exec(await Bun.file(SCRIPT).text());
  const out: ScriptOutput = { counts: {}, unshared: [], listed: [] };
  for (const { rows } of results) {
    for (const row of rows as Record<string, unknown>[]) {
      if ("unshared_connection_id" in row) out.unshared.push(row as never);
      if ("kind" in row) out.listed.push(row as never);
    }
    if (rows.length !== 1) continue;
    for (const [key, value] of Object.entries(rows[0] as Record<string, unknown>)) {
      if (/_(before|after|kept)$/.test(key)) out.counts[key] = Number(value);
    }
  }
  return out;
}

async function snapshot(): Promise<string> {
  const read = async (sql: string) => (await pg.query(sql)).rows;
  return JSON.stringify([
    await read("SELECT id, shared_with_org, updated_at FROM integration_connections ORDER BY id"),
    await read(
      "SELECT package_id, integration_package_id, user_id, connection_ids::text[] AS ids, updated_at FROM integration_pins ORDER BY package_id, integration_package_id, user_id",
    ),
    await read(
      "SELECT integration_package_id, connection_ids::text[] AS ids, updated_at FROM integration_org_defaults ORDER BY integration_package_id",
    ),
    await read("SELECT id, enabled, connection_overrides FROM package_schedules ORDER BY id"),
  ]);
}

/** `0080` in one transaction; resolves to its refusal, or `null` when it applied. */
async function apply0080(db: PGlite): Promise<Error | null> {
  const source = await Bun.file(MIGRATION_0080).text();
  try {
    await db.transaction(async (tx) => {
      await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
    });
    return null;
  } catch (error) {
    return error as Error;
  }
}

const connectionRow = (n: number, integ: string, owner: "alice" | "erin", shared: boolean) =>
  `('${conn(n)}', '${integ}', 'primary', 'acct-${n}', '${SPACE}',
    ${owner === "alice" ? `'${ALICE}'` : "NULL"}, ${owner === "erin" ? `'${ERIN}'` : "NULL"},
    'x', 'c${n}', ${shared})`;

/** An organization with Alice, Erin, two integrations and three agents; `extra` adds rows. */
async function freshDatabase(extra: string): Promise<PGlite> {
  const db = await journalPGlite({ through: REPLAY_THROUGH });
  await db.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero36', 'zero-36');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${ALICE}', 'Alice', 'a-0036@example.com', true, now(), now());
    INSERT INTO org_members (org_id, user_id, role) VALUES ('${ORG}', '${ALICE}', 'member');
    INSERT INTO end_users (id, space_id, org_id) VALUES ('${ERIN}', '${SPACE}', '${ORG}');
    INSERT INTO packages (id, type) VALUES
      ('${GMAIL}', 'integration'), ('${SLACK}', 'integration'),
      ('${AGENT}', 'agent'), ('${AGENT_2}', 'agent'), ('${AGENT_3}', 'agent');
    ${extra}
  `);
  return db;
}

const CONNECTION_COLUMNS = `INSERT INTO integration_connections
  (id, integration_package_id, auth_key, account_id, space_id, user_id, end_user_id,
   credentials_encrypted, label, shared_with_org) VALUES`;

beforeAll(async () => {
  pg = await freshDatabase(`
    ${CONNECTION_COLUMNS}
      ${connectionRow(1, GMAIL, "alice", true)},
      ${connectionRow(2, GMAIL, "alice", true)},
      ${connectionRow(3, GMAIL, "erin", true)},
      ${connectionRow(4, GMAIL, "erin", true)},
      ${connectionRow(5, GMAIL, "erin", false)},
      ${connectionRow(6, SLACK, "erin", true)},
      ${connectionRow(7, GMAIL, "erin", false)};
    INSERT INTO integration_pins (space_id, package_id, integration_package_id, user_id, connection_ids)
    VALUES
      ('${SPACE}', '${AGENT}', '${GMAIL}', NULL, ARRAY['${ERIN_SHARED}', '${ALICE_SHARED}']::uuid[]),
      ('${SPACE}', '${AGENT_2}', '${GMAIL}', NULL, ARRAY['${ERIN_PINNED_ALONE}']::uuid[]),
      ('${SPACE}', '${AGENT_3}', '${GMAIL}', NULL, ARRAY['${DEAD}', '${ERIN_UNSHARED_PINNED}']::uuid[]),
      ('${SPACE}', '${AGENT}', '${GMAIL}', '${ALICE}', ARRAY['${ERIN_SHARED}']::uuid[]);
    INSERT INTO integration_org_defaults (space_id, integration_package_id, connection_ids, enforce)
    VALUES
      ('${SPACE}', '${GMAIL}', ARRAY['${ALICE_SHARED_2}', '${ERIN_SHARED}', '${ALICE_SHARED}']::uuid[], true),
      ('${SPACE}', '${SLACK}', ARRAY['${ERIN_DEFAULT_ALONE}']::uuid[], false);
    INSERT INTO package_schedules
      (id, package_id, user_id, end_user_id, org_id, space_id, cron_expression, enabled, connection_overrides)
    VALUES
      ('sch_0036_alice', '${AGENT}', '${ALICE}', NULL, '${ORG}', '${SPACE}', '0 * * * *', true,
       '{"${GMAIL}": ["${ERIN_SHARED}"]}'),
      ('sch_0036_erin', '${AGENT}', NULL, '${ERIN}', '${ORG}', '${SPACE}', '0 * * * *', true,
       '{"${GMAIL}": ["${ERIN_SHARED}"]}');
  `);

  firstRun = await runScript(pg);
  afterFirstRun = await snapshot();
  secondRun = await runScript(pg);
  afterSecondRun = await snapshot();
  // A journal replay runs past the suite's 15s per-test timeout (`--timeout`).
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("scripts/migration/0036 — end users' connections unshared", () => {
  it("prints the size of every step, and 0 on every 'after' line", () => {
    expect(firstRun.counts).toEqual({
      end_user_shared_before: 3,
      admin_pins_before: 3,
      admin_pins_emptied_before: 1,
      org_defaults_before: 2,
      org_defaults_emptied_before: 1,
      admin_pins_dangling_kept: 1,
      org_defaults_dangling_kept: 0,
      member_pins_kept: 1,
      schedules_kept: 1,
      end_user_shared_after: 0,
      admin_pins_after: 0,
      org_defaults_after: 0,
    });
  });

  it("lists every admin pin and org default it rewrites or deletes, with its org and set before", () => {
    const set = (...ids: string[]) => `{${ids.join(",")}}`;
    const row = (kind: string, agent: string | null, integ: string, before: string) => ({
      kind,
      org_id: ORG,
      space_id: SPACE,
      agent_id: agent,
      integration_package_id: integ,
      connection_ids_before: before,
    });
    expect(firstRun.listed).toEqual([
      row("admin_pin", AGENT, GMAIL, set(ERIN_SHARED, ALICE_SHARED)),
      row("admin_pin", AGENT_2, GMAIL, set(ERIN_PINNED_ALONE)),
      row("admin_pin", AGENT_3, GMAIL, set(DEAD, ERIN_UNSHARED_PINNED)),
      row("org_default", null, GMAIL, set(ALICE_SHARED_2, ERIN_SHARED, ALICE_SHARED)),
      row("org_default", null, SLACK, set(ERIN_DEFAULT_ALONE)),
    ]);
    expect(secondRun.listed).toEqual([]);
  });

  it("removes an end user's connection, shared or not, from admin pins and org defaults, keeping the rest in order — a dangling id included — and deletes only the sets it empties", async () => {
    const pins = await pg.query<{ package_id: string; user_id: string | null; ids: string[] }>(
      `SELECT package_id, user_id, connection_ids::text[] AS ids FROM integration_pins
       ORDER BY package_id, user_id NULLS FIRST`,
    );
    expect(pins.rows).toEqual([
      { package_id: AGENT, user_id: null, ids: [ALICE_SHARED] },
      // Alice's member pin is left as an unshare leaves it: it fails loudly until she re-picks.
      { package_id: AGENT, user_id: ALICE, ids: [ERIN_SHARED] },
      { package_id: AGENT_3, user_id: null, ids: [DEAD] },
    ]);
    const defaults = await pg.query<{ integration_package_id: string; ids: string[] }>(
      `SELECT integration_package_id, connection_ids::text[] AS ids FROM integration_org_defaults
       ORDER BY integration_package_id`,
    );
    expect(defaults.rows).toEqual([
      { integration_package_id: GMAIL, ids: [ALICE_SHARED_2, ALICE_SHARED] },
    ]);
  });

  it("unshares every end user's connection, lists each one, and leaves members' shares and schedules alone", async () => {
    expect(firstRun.unshared.map((r) => r.unshared_connection_id).sort()).toEqual(
      [ERIN_SHARED, ERIN_PINNED_ALONE, ERIN_DEFAULT_ALONE].sort(),
    );
    expect(new Set(firstRun.unshared.map((r) => `${r.space_id} ${r.end_user_id}`))).toEqual(
      new Set([`${SPACE} ${ERIN}`]),
    );
    const { rows } = await pg.query<{ id: string; shared_with_org: boolean }>(
      "SELECT id, shared_with_org FROM integration_connections ORDER BY id",
    );
    expect(rows).toEqual([
      { id: ALICE_SHARED, shared_with_org: true },
      { id: ALICE_SHARED_2, shared_with_org: true },
      { id: ERIN_SHARED, shared_with_org: false },
      { id: ERIN_PINNED_ALONE, shared_with_org: false },
      { id: ERIN_PRIVATE, shared_with_org: false },
      { id: ERIN_DEFAULT_ALONE, shared_with_org: false },
      { id: ERIN_UNSHARED_PINNED, shared_with_org: false },
    ]);
    const schedules = await pg.query<{
      id: string;
      enabled: boolean;
      connection_overrides: Record<string, string[]>;
    }>("SELECT id, enabled, connection_overrides FROM package_schedules ORDER BY id");
    expect(schedules.rows).toEqual([
      { id: "sch_0036_alice", enabled: true, connection_overrides: { [GMAIL]: [ERIN_SHARED] } },
      { id: "sch_0036_erin", enabled: true, connection_overrides: { [GMAIL]: [ERIN_SHARED] } },
    ]);
  });

  it("changes nothing on a second run, and finds nothing to do", () => {
    expect(afterSecondRun).toBe(afterFirstRun);
    expect(secondRun.unshared).toEqual([]);
    // Informational and untouched: the dangling id stays, so its pin is still counted.
    expect(secondRun.counts.admin_pins_dangling_kept).toBe(1);
    expect(
      Object.entries(secondRun.counts).filter(([key, n]) => n !== 0 && !key.endsWith("_kept")),
    ).toEqual([]);
  });

  it("leaves 0080 applicable, whose CHECK then refuses a shared end user's connection", async () => {
    expect(await apply0080(pg)).toBeNull();
    let refusal: unknown;
    try {
      await pg.exec(
        `UPDATE integration_connections SET shared_with_org = true WHERE id = '${ERIN_PRIVATE}'`,
      );
    } catch (error) {
      refusal = error;
    }
    expect((refusal as Error | undefined)?.message).toContain(
      "integration_connections_end_user_not_shared",
    );
  });
});

describe("drizzle 0080 — its guard refuses each state 0036 repairs, alone", () => {
  const cases: [string, string][] = [
    [
      "an end user's shared connection, named nowhere",
      `${CONNECTION_COLUMNS} ${connectionRow(3, GMAIL, "erin", true)};`,
    ],
    [
      "an admin pin naming an end user's unshared connection",
      `${CONNECTION_COLUMNS} ${connectionRow(7, GMAIL, "erin", false)};
       INSERT INTO integration_pins (space_id, package_id, integration_package_id, user_id, connection_ids)
       VALUES ('${SPACE}', '${AGENT}', '${GMAIL}', NULL, ARRAY['${ERIN_UNSHARED_PINNED}']::uuid[]);`,
    ],
    [
      "an org default naming an end user's unshared connection",
      `${CONNECTION_COLUMNS} ${connectionRow(7, GMAIL, "erin", false)};
       INSERT INTO integration_org_defaults (space_id, integration_package_id, connection_ids, enforce)
       VALUES ('${SPACE}', '${GMAIL}', ARRAY['${ERIN_UNSHARED_PINNED}']::uuid[], false);`,
    ],
  ];

  for (const [state, rows] of cases) {
    it(`refuses ${state}, naming the script`, async () => {
      const db = await freshDatabase(rows);
      try {
        expect((await apply0080(db))?.message).toContain(
          "scripts/migration/0036-unshare-end-user-connections.sql",
        );
      } finally {
        await db.close();
      }
    }, 300_000);
  }
});
