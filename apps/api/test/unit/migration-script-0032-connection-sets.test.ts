// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0032-connection-sets.sql` on a private PGlite replayed to
 * `0076` — the schema it runs against, one migration short of `0077`, which is
 * also the only place its duplicate labels are seedable. Run twice, then `0077`
 * on top: the script is what makes that batch's unique label index creatable.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { replayJournal } from "../helpers/journal.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = `${REPO_ROOT}/scripts/migration/0032-connection-sets.sql`;
const MIGRATION_0077 = `${REPO_ROOT}/packages/db/drizzle/0077_connection_sets.sql`;
const REPLAY_THROUGH = "0076_space_packages_chat_enforced";

const ORG = "e0000000-0000-4000-8000-00000000d032";
const SPACE = "spc_d0320000-0000-4000-8000-000000000001";
const ALICE = "usr_0032_alice";
const BOB = "usr_0032_bob";
/** Left the organization before the deploy: a `user` row, no `org_members` row. */
const CAROL = "usr_0032_carol";
const GMAIL = "@acme0032/gmail";
const SLACK = "@acme0032/slack";
const NOTION = "@acme0032/notion";
const DRIVE = "@acme0032/drive";
const CAL = "@acme0032/cal";
const AGENT = "@acme0032/agent";

const conn = (n: number) => `d0320000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Two 80-character labels that share their first 78 characters. */
const LONG_AB = `${"x".repeat(78)}AB`;
const LONG_CD = `${"x".repeat(78)}CD`;
/** 40 code points, 80 UTF-16 units — the unit `CONNECTION_LABEL_MAX` counts in. */
const EMOJI = "😀".repeat(40);

const pg = new PGlite();
let afterFirstRun = "";
let afterSecondRun = "";

async function labelOf(id: string): Promise<string | null> {
  const { rows } = await pg.query<{ label: string | null }>(
    "SELECT label FROM integration_connections WHERE id = $1",
    [id],
  );
  return rows[0]!.label;
}

async function memberPins(): Promise<{ integration: string; user: string; connection: string }[]> {
  const { rows } = await pg.query<{ integration: string; user: string; connection: string }>(
    `SELECT integration_package_id AS integration, user_id AS "user", connection_id::text AS connection
     FROM integration_pins WHERE user_id IS NOT NULL ORDER BY integration_package_id`,
  );
  return rows;
}

async function snapshot(): Promise<string> {
  const read = async (sql: string) => (await pg.query(sql)).rows;
  return JSON.stringify([
    await read("SELECT id, connection_overrides, resolved_connections FROM runs ORDER BY id"),
    await read("SELECT id, connection_overrides FROM package_schedules ORDER BY id"),
    await read(
      "SELECT id, label, shared_with_org, updated_at FROM integration_connections ORDER BY id",
    ),
    await read("SELECT * FROM integration_pins ORDER BY integration_package_id, user_id"),
  ]);
}

beforeAll(async () => {
  await replayJournal(pg, REPLAY_THROUGH);

  // Every label-only row is unhealthy, so none of them is a candidate the
  // freeze's "only healthy connection the user can reach" test would count.
  const connection = (
    n: number,
    integ: string,
    owner: string,
    label: string | null,
    shared: boolean,
    at: string,
  ) =>
    `('${conn(n)}', '${integ}', 'primary', 'acct-${n}', '${SPACE}', '${owner}', 'x', ${
      label === null ? "NULL" : `'${label}'`
    }, ${shared}, ${n >= 10}, '${at}')`;
  const pick = (n: number, source = "fallback_auto") => ({
    connectionId: conn(n),
    source,
    label: "l",
    accountId: "a",
  });
  const run = (
    id: string,
    daysAgo: number,
    schedule: string | null,
    resolved: Record<string, unknown>,
    overrides: Record<string, unknown> | null = null,
  ) =>
    `('${id}', '${AGENT}', '${ALICE}', '${SPACE}', '${ORG}', 'success',
      now() - interval '${daysAgo} days', ${schedule === null ? "NULL" : `'${schedule}'`},
      '${JSON.stringify(resolved)}', ${overrides === null ? "NULL" : `'${JSON.stringify(overrides)}'`})`;

  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero32', 'zero-32');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${ALICE}', 'Alice', 'a-0032@example.com', true, now(), now()),
      ('${BOB}', 'Bob', 'b-0032@example.com', true, now(), now()),
      ('${CAROL}', 'Carol', 'c-0032@example.com', true, now(), now());
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('${ORG}', '${ALICE}', 'member'), ('${ORG}', '${BOB}', 'member');
    INSERT INTO packages (id, type) VALUES
      ('${GMAIL}', 'integration'), ('${SLACK}', 'integration'), ('${NOTION}', 'integration'),
      ('${DRIVE}', 'integration'), ('${CAL}', 'integration'), ('${AGENT}', 'agent');
    INSERT INTO integration_connections
      (id, integration_package_id, auth_key, account_id, space_id, user_id,
       credentials_encrypted, label, shared_with_org, needs_reconnection, created_at)
    VALUES
      ${connection(1, GMAIL, BOB, "Bob Gmail", true, "2026-01-01")},
      ${connection(2, SLACK, BOB, "prod", true, "2026-01-01")},
      ${connection(3, NOTION, BOB, "Notion", true, "2026-01-01")},
      ${connection(4, DRIVE, CAROL, "Drive", true, "2026-01-01")},
      ${connection(5, CAL, BOB, "Cal", true, "2026-01-01")},
      ${connection(10, GMAIL, ALICE, "prod", false, "2026-02-01")},
      ${connection(11, GMAIL, BOB, "prod", false, "2026-02-02")},
      ${connection(12, GMAIL, BOB, "prod (2)", false, "2026-02-03")},
      ${connection(13, GMAIL, ALICE, "prod", false, "2026-02-04")},
      ${connection(14, GMAIL, BOB, "Prod", false, "2026-02-05")},
      ${connection(15, GMAIL, ALICE, null, false, "2026-02-06")},
      ${connection(16, GMAIL, BOB, "", false, "2026-02-07")},
      ${connection(17, GMAIL, ALICE, null, false, "2026-02-08")},
      ${connection(18, GMAIL, ALICE, "Connexion 3", false, "2026-02-09")},
      ${connection(19, GMAIL, BOB, "Connexion 3", false, "2026-02-10")},
      ${connection(20, GMAIL, ALICE, LONG_AB, false, "2026-02-11")},
      ${connection(21, GMAIL, BOB, LONG_AB, false, "2026-02-12")},
      ${connection(22, GMAIL, ALICE, LONG_CD, false, "2026-02-13")},
      ${connection(23, GMAIL, BOB, LONG_CD, false, "2026-02-14")},
      ${connection(24, GMAIL, ALICE, EMOJI, false, "2026-02-15")},
      ${connection(25, GMAIL, BOB, EMOJI, false, "2026-02-16")};
    INSERT INTO package_schedules
      (id, package_id, user_id, org_id, space_id, cron_expression, enabled, connection_overrides)
    VALUES
      ('sch_0032_monthly', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 0 1 * *', true, NULL),
      ('sch_0032_off', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 0 1 * *', false, NULL),
      ('sch_0032_scalar', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', true,
       '{"${GMAIL}": "${conn(1)}"}'),
      ('sch_0032_array', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', true,
       '{"${GMAIL}": ["${conn(1)}"]}'),
      ('sch_0032_empty', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', true, '{}');
    INSERT INTO integration_org_defaults (space_id, integration_package_id, connection_id, enforce)
      VALUES ('${SPACE}', '${DRIVE}', '${conn(4)}', false);
    INSERT INTO runs
      (id, package_id, user_id, space_id, org_id, status, started_at, schedule_id,
       resolved_connections, connection_overrides)
    VALUES
      ${run("run_0032_recent", 2, null, { [GMAIL]: pick(1), [DRIVE]: pick(4) }, { [GMAIL]: conn(1) })},
      ${run("run_0032_monthly", 90, "sch_0032_monthly", { [SLACK]: pick(2) })},
      ${run("run_0032_monthly_prev", 120, "sch_0032_monthly", { [SLACK]: pick(2) })},
      ${run("run_0032_off", 90, "sch_0032_off", { [NOTION]: pick(3) })},
      ${run("run_0032_manual_old", 90, null, { [CAL]: pick(5) })},
      ${run("run_0032_array", 1, null, { [GMAIL]: [pick(1, "member_pin")] }, { [GMAIL]: [conn(1)] })},
      ${run("run_0032_empty", 1, null, {}, {})};
  `);

  const script = await Bun.file(SCRIPT).text();
  await pg.exec(script);
  afterFirstRun = await snapshot();
  await pg.exec(script);
  afterSecondRun = await snapshot();
  // A journal replay runs past the 15s default in `bunfig.toml`.
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("scripts/migration/0032 — connection sets", () => {
  it("rewrites every scalar pick into a one-element set and leaves arrays and {} alone", async () => {
    const { rows: runs } = await pg.query<{
      id: string;
      overrides: unknown;
      resolved: Record<string, unknown>;
    }>(
      `SELECT id, connection_overrides AS overrides, resolved_connections AS resolved
       FROM runs WHERE id IN ('run_0032_recent', 'run_0032_array', 'run_0032_empty') ORDER BY id`,
    );
    expect(runs.map((r) => [r.id, r.overrides])).toEqual([
      ["run_0032_array", { [GMAIL]: [conn(1)] }],
      ["run_0032_empty", {}],
      ["run_0032_recent", { [GMAIL]: [conn(1)] }],
    ]);
    const recent = runs.find((r) => r.id === "run_0032_recent")!.resolved;
    expect(recent[GMAIL]).toEqual([
      { connectionId: conn(1), source: "fallback_auto", label: "l", accountId: "a" },
    ]);
    expect(runs.find((r) => r.id === "run_0032_empty")!.resolved).toEqual({});

    const { rows: schedules } = await pg.query<{ id: string; overrides: unknown }>(
      `SELECT id, connection_overrides AS overrides FROM package_schedules
       WHERE id LIKE 'sch_0032_%' AND connection_overrides IS NOT NULL ORDER BY id`,
    );
    expect(schedules).toEqual([
      { id: "sch_0032_array", overrides: { [GMAIL]: [conn(1)] } },
      { id: "sch_0032_empty", overrides: {} },
      { id: "sch_0032_scalar", overrides: { [GMAIL]: [conn(1)] } },
    ]);
  });

  it("unshares the connections of an owner who left the organization, and only those", async () => {
    const { rows } = await pg.query<{ id: string; shared: boolean }>(
      `SELECT id::text, shared_with_org AS shared FROM integration_connections
       WHERE id IN ('${conn(1)}', '${conn(4)}') ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: conn(1), shared: true },
      { id: conn(4), shared: false },
    ]);
  });

  it("freezes an implicit shared pick as the actor's member pin — recent runs, and the latest run of an enabled schedule of any age", async () => {
    // GMAIL: a run of the last 30 days. SLACK: a monthly schedule last fired
    // 90 days ago. NOTION (a disabled schedule) and CAL (an old manual run) are
    // past the window; DRIVE leaned on a departed owner's connection.
    expect(await memberPins()).toEqual([
      { integration: GMAIL, user: ALICE, connection: conn(1) },
      { integration: SLACK, user: ALICE, connection: conn(2) },
    ]);
    const { rows } = await pg.query<{ created_by: string }>(
      "SELECT created_by FROM integration_pins WHERE user_id IS NOT NULL",
    );
    expect(rows.every((r) => r.created_by === ALICE)).toBe(true);
  });

  it("renames all but the oldest holder of a label past every '(n)' already held", async () => {
    expect(await labelOf(conn(10))).toBe("prod");
    expect(await labelOf(conn(12))).toBe("prod (2)");
    expect(await labelOf(conn(11))).toBe("prod (3)");
    expect(await labelOf(conn(13))).toBe("prod (4)");
    expect(await labelOf(conn(18))).toBe("Connexion 3");
    expect(await labelOf(conn(19))).toBe("Connexion 3 (2)");
    // Verbatim comparison: case makes another label; another integration another group.
    expect(await labelOf(conn(14))).toBe("Prod");
    expect(await labelOf(conn(2))).toBe("prod");
  });

  it("keeps a renamed label within 80 UTF-16 units, without collision between labels cut to one prefix", async () => {
    // The GMAIL group holds 17 rows, so the widest suffix is " (35)" and the
    // base keeps 75 units. Both long labels cut to the same 75 "x".
    const base = "x".repeat(75);
    expect(await labelOf(conn(20))).toBe(LONG_AB);
    expect(await labelOf(conn(22))).toBe(LONG_CD);
    expect(await labelOf(conn(21))).toBe(`${base} (2)`);
    expect(await labelOf(conn(23))).toBe(`${base} (3)`);
    // 37 emoji are 74 units: a 38th would overflow the room.
    expect(await labelOf(conn(24))).toBe(EMOJI);
    const emoji = (await labelOf(conn(25)))!;
    expect(emoji).toBe(`${"😀".repeat(37)} (2)`);
    expect(emoji.length).toBeLessThanOrEqual(80);
  });

  it("leaves NULL and empty labels to 0077's backfill", async () => {
    expect(await labelOf(conn(15))).toBeNull();
    expect(await labelOf(conn(16))).toBe("");
    expect(await labelOf(conn(17))).toBeNull();
  });

  it("changes nothing on a second run", () => {
    expect(afterSecondRun).toBe(afterFirstRun);
  });

  it("leaves 0077 applicable: its backfill mints past every 'Connexion N' and the unique index lands", async () => {
    await pg.transaction(async (tx) => {
      const source = await Bun.file(MIGRATION_0077).text();
      await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
    });
    expect(await labelOf(conn(15))).toBe("Connexion 4");
    expect(await labelOf(conn(16))).toBe("Connexion 5");
    expect(await labelOf(conn(17))).toBe("Connexion 6");
    const { rows } = await pg.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_integration_conn_label'",
    );
    expect(rows).toEqual([{ indexname: "idx_integration_conn_label" }]);
    const pins = await pg.query<{ ids: string[] }>(
      "SELECT connection_ids::text[] AS ids FROM integration_pins WHERE user_id IS NOT NULL ORDER BY integration_package_id",
    );
    expect(pins.rows).toEqual([{ ids: [conn(1)] }, { ids: [conn(2)] }]);
  });
});
