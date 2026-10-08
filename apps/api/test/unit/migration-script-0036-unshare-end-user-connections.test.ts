// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0036-unshare-end-user-connections.sql` on a private PGlite replayed to
 * `0079` — the schema it runs against, one migration short of `0080`, which is also the only
 * place a shared end user's connection is seedable. `0080` refuses that state first, then the
 * script runs twice, then `0080` lands on top: the script is its precondition.
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

const conn = (n: number) => `d0360000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Alice's, shared: every set keeps it. */
const ALICE_SHARED = conn(1);
const ALICE_SHARED_2 = conn(2);
/** Erin's, shared: in a two-id admin pin, a two-id default, Alice's member pin and schedule. */
const ERIN_SHARED = conn(3);
/** Erin's, shared: alone in an admin pin. */
const ERIN_PINNED_ALONE = conn(4);
/** Erin's, never shared, named nowhere. */
const ERIN_PRIVATE = conn(5);
/** Erin's, shared: alone in an org default. */
const ERIN_DEFAULT_ALONE = conn(6);

let pg: PGlite;
let refusalBefore: unknown;
let afterFirstRun = "";
let afterSecondRun = "";
let firstRunCounts: Record<string, number> = {};
let secondRunCounts: Record<string, number> = {};

/** The one-row count lines the script prints, merged — never its listing. */
async function runScript(script: string): Promise<Record<string, number>> {
  const results = await pg.exec(script);
  const counts: Record<string, number> = {};
  for (const { rows } of results) {
    if (rows.length !== 1) continue;
    for (const [key, value] of Object.entries(rows[0] as Record<string, unknown>)) {
      if (/_(before|after|kept)$/.test(key)) counts[key] = Number(value);
    }
  }
  return counts;
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

async function apply0080(): Promise<void> {
  const source = await Bun.file(MIGRATION_0080).text();
  await pg.transaction(async (tx) => {
    await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
  });
}

beforeAll(async () => {
  pg = await journalPGlite({ through: REPLAY_THROUGH });

  const connection = (n: number, integ: string, owner: "alice" | "erin", shared: boolean) =>
    `('${conn(n)}', '${integ}', 'primary', 'acct-${n}', '${SPACE}',
      ${owner === "alice" ? `'${ALICE}'` : "NULL"}, ${owner === "erin" ? `'${ERIN}'` : "NULL"},
      'x', 'c${n}', ${shared})`;

  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero36', 'zero-36');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${ALICE}', 'Alice', 'a-0036@example.com', true, now(), now());
    INSERT INTO org_members (org_id, user_id, role) VALUES ('${ORG}', '${ALICE}', 'member');
    INSERT INTO end_users (id, space_id, org_id) VALUES ('${ERIN}', '${SPACE}', '${ORG}');
    INSERT INTO packages (id, type) VALUES
      ('${GMAIL}', 'integration'), ('${SLACK}', 'integration'),
      ('${AGENT}', 'agent'), ('${AGENT_2}', 'agent');
    INSERT INTO integration_connections
      (id, integration_package_id, auth_key, account_id, space_id, user_id, end_user_id,
       credentials_encrypted, label, shared_with_org)
    VALUES
      ${connection(1, GMAIL, "alice", true)},
      ${connection(2, GMAIL, "alice", true)},
      ${connection(3, GMAIL, "erin", true)},
      ${connection(4, GMAIL, "erin", true)},
      ${connection(5, GMAIL, "erin", false)},
      ${connection(6, SLACK, "erin", true)};
    INSERT INTO integration_pins (space_id, package_id, integration_package_id, user_id, connection_ids)
    VALUES
      ('${SPACE}', '${AGENT}', '${GMAIL}', NULL, ARRAY['${ERIN_SHARED}', '${ALICE_SHARED}']::uuid[]),
      ('${SPACE}', '${AGENT_2}', '${GMAIL}', NULL, ARRAY['${ERIN_PINNED_ALONE}']::uuid[]),
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

  try {
    await apply0080();
  } catch (error) {
    refusalBefore = error;
  }
  const script = await Bun.file(SCRIPT).text();
  firstRunCounts = await runScript(script);
  afterFirstRun = await snapshot();
  secondRunCounts = await runScript(script);
  afterSecondRun = await snapshot();
  // A journal replay runs past the suite's 15s per-test timeout (`--timeout`).
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("scripts/migration/0036 — end users' connections unshared", () => {
  it("is what 0080 asks for: the batch refuses the state the script repairs, naming it", () => {
    expect((refusalBefore as Error | undefined)?.message).toContain(
      "scripts/migration/0036-unshare-end-user-connections.sql",
    );
  });

  it("prints the size of every step, and 0 on every 'after' line", () => {
    expect(firstRunCounts).toEqual({
      end_user_shared_before: 3,
      admin_pins_before: 2,
      admin_pins_emptied_before: 1,
      org_defaults_before: 2,
      org_defaults_emptied_before: 1,
      member_pins_kept: 1,
      schedules_kept: 1,
      end_user_shared_after: 0,
      admin_pins_after: 0,
      org_defaults_after: 0,
    });
  });

  it("removes an end user's connection from admin pins and org defaults, keeping the rest in order, and deletes the sets it empties", async () => {
    const pins = await pg.query<{ package_id: string; user_id: string | null; ids: string[] }>(
      `SELECT package_id, user_id, connection_ids::text[] AS ids FROM integration_pins
       ORDER BY package_id, user_id NULLS FIRST`,
    );
    expect(pins.rows).toEqual([
      { package_id: AGENT, user_id: null, ids: [ALICE_SHARED] },
      // Alice's member pin is left as an unshare leaves it: it fails loudly until she re-picks.
      { package_id: AGENT, user_id: ALICE, ids: [ERIN_SHARED] },
    ]);
    const defaults = await pg.query<{ integration_package_id: string; ids: string[] }>(
      `SELECT integration_package_id, connection_ids::text[] AS ids FROM integration_org_defaults
       ORDER BY integration_package_id`,
    );
    expect(defaults.rows).toEqual([
      { integration_package_id: GMAIL, ids: [ALICE_SHARED_2, ALICE_SHARED] },
    ]);
  });

  it("unshares every end user's connection and leaves members' shares and schedules alone", async () => {
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
    ]);
    const schedules = await pg.query<{ id: string; enabled: boolean }>(
      "SELECT id, enabled FROM package_schedules ORDER BY id",
    );
    expect(schedules.rows).toEqual([
      { id: "sch_0036_alice", enabled: true },
      { id: "sch_0036_erin", enabled: true },
    ]);
  });

  it("changes nothing on a second run, and finds nothing to do", () => {
    expect(afterSecondRun).toBe(afterFirstRun);
    expect(
      Object.entries(secondRunCounts).filter(([key, n]) => n !== 0 && !key.endsWith("_kept")),
    ).toEqual([]);
  });

  it("leaves 0080 applicable, whose CHECK then refuses a shared end user's connection", async () => {
    await apply0080();
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
