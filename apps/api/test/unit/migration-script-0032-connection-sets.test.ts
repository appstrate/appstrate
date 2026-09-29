// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0032-connection-sets.sql` on a private PGlite replayed to
 * `0076` — the schema it runs against, one migration short of `0077`, which is
 * also the only place its duplicate labels are seedable. Run twice, then `0077`
 * on top: the script is what makes that batch's unique label index creatable.
 *
 * Each freeze fixture is a connection the old fallback DID pick, and each
 * exercises one clause of the freeze: deleting that clause makes a pin appear
 * or vanish, or moves the counts the script prints. The `GOV_*` fixtures do the
 * same for the outranked drop.
 *
 * PGlite runs the SQL after the file's psql fence (`\if :{?ran_0033}`), which it
 * cannot parse; the fence itself is psql's, not exercised here.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { replayJournal } from "../helpers/journal.ts";
import { CONNECTION_LABEL_MAX, connectionLabelProblem } from "../../src/lib/connection-label.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = `${REPO_ROOT}/scripts/migration/0032-connection-sets.sql`;
const MIGRATION_0077 = `${REPO_ROOT}/packages/db/drizzle/0077_connection_sets.sql`;
const REPLAY_THROUGH = "0076_space_packages_chat_enforced";

const ORG = "e0000000-0000-4000-8000-00000000d032";
const SPACE = "spc_d0320000-0000-4000-8000-000000000001";
/** Holds the only admin pin and enforced default of `GOV_OTHER`: they govern there, not in `SPACE`. */
const OTHER_SPACE = "spc_d0320000-0000-4000-8000-000000000002";
const ALICE = "usr_0032_alice";
const BOB = "usr_0032_bob";
/** Left the organization before the deploy: a `user` row, no `org_members` row. */
const CAROL = "usr_0032_carol";
const END_USER = "eu_0032_erin";
const GMAIL = "@acme0032/gmail";
const SLACK = "@acme0032/slack";
const NOTION = "@acme0032/notion";
const DRIVE = "@acme0032/drive";
const CAL = "@acme0032/cal";
/** One freeze clause each — see the fixture table in `beforeAll`. */
const TWIN = "@acme0032/twin";
const OWNED = "@acme0032/owned";
const ADMIN = "@acme0032/admin";
const MINE = "@acme0032/mine";
const DEFAULTED = "@acme0032/defaulted";
const UNREACH = "@acme0032/unreach";
const EU = "@acme0032/eu";
const INLINE = "@acme0032/inline";
const AUTH_GONE = "@acme0032/authgone";
const AUTH_KEPT = "@acme0032/authkept";
const AUTH_PIN = "@acme0032/authpin";
const AUTH_LATEST = "@acme0032/authlatest";
const OVERRIDDEN = "@acme0032/overridden";
const UNSHARED = "@acme0032/unshared";
const LEAVER = "@acme0032/leaver";
const STALE = "@acme0032/stale";
const LABELS = "@acme0032/labels";
/** Outranked drop: an admin pin (and an enforced default below it), an enforced default, a soft one. */
const GOV_PIN = "@acme0032/gov-pin";
const GOV_ENF = "@acme0032/gov-enforced";
const GOV_SOFT = "@acme0032/gov-soft";
const GOV_OTHER = "@acme0032/gov-other-space";
const AGENT = "@acme0032/agent";
const SHADOW = "@acme0032/inline-shadow";

const conn = (n: number) => `d0320000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Two 80-character labels that share their first 78 characters. */
const LONG_AB = `${"x".repeat(78)}AB`;
const LONG_CD = `${"x".repeat(78)}CD`;
/** 40 code points, 80 UTF-16 units — the unit `CONNECTION_LABEL_MAX` counts in. */
const EMOJI = "😀".repeat(40);
/** Every code point `connectionLabelProblem` forbids, NUL aside (a `text` cannot hold it). */
const FORBIDDEN = (() => {
  let out = "";
  for (let cp = 1; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (connectionLabelProblem(`a${ch}a`)?.includes("control")) out += ch;
  }
  return out;
})();

const pg = new PGlite();
let afterFirstRun = "";
let afterSecondRun = "";
let firstRunCounts: Record<string, number> = {};
let secondRunCounts: Record<string, number> = {};

const sqlText = (value: string | null) =>
  value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;

/** The file past its psql fence — which must be there, first. */
async function scriptSql(): Promise<string> {
  const fence = /^\\set ON_ERROR_STOP on\n\\if :\{\?ran_0033\}\n\\else\n[\s\S]*?\n\\endif\n/m;
  const file = await Bun.file(SCRIPT).text();
  expect(file).toMatch(fence);
  return file.replace(fence, "");
}

/** Every one-row result the script prints, merged: `{ implicit_shared_picks_before: 4, … }`. */
async function runScript(script: string): Promise<Record<string, number>> {
  const results = await pg.exec(script);
  const counts: Record<string, number> = {};
  for (const { rows } of results) {
    if (rows.length !== 1) continue;
    for (const [key, value] of Object.entries(rows[0] as Record<string, unknown>)) {
      counts[key] = Number(value);
    }
  }
  return counts;
}

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

  // Every label-only row is unhealthy and unshared, so none of them is a
  // candidate the freeze's "only healthy connection the user can reach" test
  // would count.
  const connection = (
    n: number,
    integ: string,
    owner: string,
    label: string | null,
    opts: {
      shared?: boolean;
      healthy?: boolean;
      at?: string;
      authKey?: string;
      space?: string;
    } = {},
  ) =>
    `('${conn(n)}', '${integ}', '${opts.authKey ?? "primary"}', 'acct-${n}', '${opts.space ?? SPACE}', '${owner}', 'x',
      ${sqlText(label)}, ${opts.shared ?? false}, ${!(opts.healthy ?? false)}, '${opts.at ?? "2026-01-01"}')`;
  /** A shared, healthy connection of Bob's: the kind the old fallback handed Alice. */
  const bobShared = (n: number, integ: string, authKey?: string) =>
    connection(n, integ, BOB, `c${n}`, { shared: true, healthy: true, authKey });
  const label = (n: number, value: string | null, at = "2026-03-01") =>
    connection(n, LABELS, ALICE, value, { at });
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
    resolved: Record<string, unknown> | null,
    opts: {
      overrides?: Record<string, unknown>;
      agent?: string;
      user?: string | null;
      endUser?: string;
    } = {},
  ) =>
    `('${id}', '${opts.agent ?? AGENT}', ${sqlText(opts.user === undefined ? ALICE : opts.user)},
      ${sqlText(opts.endUser ?? null)}, '${SPACE}', '${ORG}', 'success',
      now() - interval '${daysAgo} days', ${sqlText(schedule)},
      ${resolved === null ? "NULL" : sqlText(JSON.stringify(resolved))},
      ${opts.overrides === undefined ? "NULL" : sqlText(JSON.stringify(opts.overrides))})`;

  const agentDraft = {
    integrations_configuration: {
      [AUTH_PIN]: { auth_key: "session" },
      [AUTH_KEPT]: { auth_key: "primary" },
    },
  };
  const agentLatest = { integrations_configuration: { [AUTH_LATEST]: { auth_key: "session" } } };
  /** Tagged `beta`, not `latest`: a version no run reads by default is not read. */
  const agentBeta = { integrations_configuration: { [AUTH_KEPT]: { auth_key: "session" } } };

  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero32', 'zero-32');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES
      ('${SPACE}', '${ORG}', 'Default', true), ('${OTHER_SPACE}', '${ORG}', 'Other', false);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${ALICE}', 'Alice', 'a-0032@example.com', true, now(), now()),
      ('${BOB}', 'Bob', 'b-0032@example.com', true, now(), now()),
      ('${CAROL}', 'Carol', 'c-0032@example.com', true, now(), now());
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('${ORG}', '${ALICE}', 'member'), ('${ORG}', '${BOB}', 'member');
    INSERT INTO end_users (id, space_id, org_id) VALUES ('${END_USER}', '${SPACE}', '${ORG}');
    INSERT INTO packages (id, type) VALUES
      ('${GMAIL}', 'integration'), ('${SLACK}', 'integration'), ('${NOTION}', 'integration'),
      ('${DRIVE}', 'integration'), ('${CAL}', 'integration'), ('${TWIN}', 'integration'),
      ('${OWNED}', 'integration'), ('${ADMIN}', 'integration'), ('${MINE}', 'integration'),
      ('${DEFAULTED}', 'integration'), ('${UNREACH}', 'integration'), ('${EU}', 'integration'),
      ('${INLINE}', 'integration'), ('${AUTH_PIN}', 'integration'),
      ('${AUTH_LATEST}', 'integration'), ('${OVERRIDDEN}', 'integration'), ('${LABELS}', 'integration'),
      ('${UNSHARED}', 'integration'), ('${LEAVER}', 'integration'), ('${STALE}', 'integration'),
      ('${GOV_PIN}', 'integration'), ('${GOV_ENF}', 'integration'), ('${GOV_SOFT}', 'integration'),
      ('${GOV_OTHER}', 'integration');
    INSERT INTO packages (id, type, draft_manifest) VALUES
      ('${AUTH_GONE}', 'integration', '{"auths": {"oauth": {}}}'),
      ('${AUTH_KEPT}', 'integration', '{"auths": {"primary": {}}}'),
      ('${AGENT}', 'agent', ${sqlText(JSON.stringify(agentDraft))});
    INSERT INTO packages (id, type, ephemeral) VALUES ('${SHADOW}', 'agent', true);
    INSERT INTO package_versions (package_id, version, integrity, artifact_size, manifest) VALUES
      ('${AGENT}', '1.0.0', 'sha256-x', 1, ${sqlText(JSON.stringify(agentLatest))}),
      ('${AGENT}', '0.9.0', 'sha256-y', 1, ${sqlText(JSON.stringify(agentBeta))});
    INSERT INTO package_dist_tags (package_id, tag, version_id)
      SELECT package_id, CASE version WHEN '1.0.0' THEN 'latest' ELSE 'beta' END, id
      FROM package_versions WHERE package_id = '${AGENT}';
    INSERT INTO integration_connections
      (id, integration_package_id, auth_key, account_id, space_id, user_id,
       credentials_encrypted, label, shared_with_org, needs_reconnection, created_at)
    VALUES
      ${bobShared(1, GMAIL)},
      ${connection(2, SLACK, BOB, "prod", { shared: true, healthy: true })},
      ${bobShared(3, NOTION)},
      ${connection(4, DRIVE, CAROL, "Drive", { shared: true, healthy: true })},
      ${bobShared(5, CAL)},
      ${connection(6, SLACK, BOB, "Slack old", { shared: true })},
      ${connection(10, GMAIL, ALICE, "prod", { at: "2026-02-01" })},
      ${connection(11, GMAIL, BOB, "prod", { at: "2026-02-02" })},
      ${connection(12, GMAIL, BOB, "prod (2)", { at: "2026-02-03" })},
      ${connection(13, GMAIL, ALICE, "prod", { at: "2026-02-04" })},
      ${connection(14, GMAIL, BOB, "Prod", { at: "2026-02-05" })},
      ${connection(15, GMAIL, ALICE, null, { at: "2026-02-06" })},
      ${connection(16, GMAIL, BOB, "", { at: "2026-02-07" })},
      ${connection(17, GMAIL, ALICE, null, { at: "2026-02-08" })},
      ${connection(18, GMAIL, ALICE, "Connexion 3", { at: "2026-02-09" })},
      ${connection(19, GMAIL, BOB, "Connexion 3", { at: "2026-02-10" })},
      ${connection(20, GMAIL, ALICE, LONG_AB, { at: "2026-02-11" })},
      ${connection(21, GMAIL, BOB, LONG_AB, { at: "2026-02-12" })},
      ${connection(22, GMAIL, ALICE, LONG_CD, { at: "2026-02-13" })},
      ${connection(23, GMAIL, BOB, LONG_CD, { at: "2026-02-14" })},
      ${connection(24, GMAIL, ALICE, EMOJI, { at: "2026-02-15" })},
      ${connection(25, GMAIL, BOB, EMOJI, { at: "2026-02-16" })},
      ${bobShared(30, TWIN)},
      ${bobShared(31, TWIN)},
      ${bobShared(32, OWNED)},
      ${connection(33, OWNED, ALICE, "mine", { healthy: true })},
      ${bobShared(34, ADMIN)},
      ${bobShared(35, MINE)},
      ${connection(36, MINE, ALICE, "mine")},
      ${bobShared(37, DEFAULTED)},
      ${bobShared(38, UNREACH)},
      ${connection(39, UNREACH, BOB, "bob private", { healthy: true })},
      ${bobShared(40, EU)},
      ${bobShared(41, INLINE)},
      ${bobShared(42, AUTH_GONE)},
      ${bobShared(43, AUTH_KEPT)},
      ${bobShared(44, AUTH_PIN)},
      ${bobShared(45, AUTH_LATEST)},
      ${bobShared(46, OVERRIDDEN)},
      ${connection(47, UNSHARED, BOB, "c47", { healthy: true })},
      ${bobShared(48, LEAVER)},
      ${connection(49, STALE, BOB, "c49", { shared: true })},
      ${bobShared(70, GOV_PIN)},
      ${bobShared(71, GOV_PIN)},
      ${bobShared(73, GOV_ENF)},
      ${bobShared(74, GOV_ENF)},
      ${bobShared(75, GOV_SOFT)},
      ${bobShared(76, GOV_SOFT)},
      ${bobShared(77, GOV_OTHER)},
      ${connection(78, GOV_OTHER, BOB, "c78", { shared: true, healthy: true, space: OTHER_SPACE })},
      ${label(50, "Work\nMail")},
      ${label(51, "Ops\u0007Bot\u007F\u009B")},
      ${label(52, "‮gnp.exe")},
      ${label(53, "Team​A­")},
      ${label(54, "  \t 　 ")},
      ${label(55, "  Sales    Team \r\n")},
      ${label(56, "Prod", "2026-02-01")},
      ${label(57, "Prod‍")},
      ${label(58, "Tag\u{E0041}X﻿")},
      ${label(59, `${"a".repeat(79)}\tbb`)},
      ${label(60, `${EMOJI}\u0085z`)},
      ${label(61, "Clean one")},
      ${label(62, "Two  spaces")},
      ${label(63, "Two spaces")},
      ${label(64, "No\u00A0break")},
      ${label(65, "No break")},
      ${label(66, `Hid${FORBIDDEN}den`)};
    INSERT INTO package_schedules
      (id, package_id, user_id, org_id, space_id, cron_expression, enabled, connection_overrides)
    VALUES
      ('sch_0032_monthly', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 0 1 * *', true, NULL),
      ('sch_0032_off', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 0 1 * *', false, NULL),
      ('sch_0032_scalar', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', true,
       '{"${GMAIL}": "${conn(1)}"}'),
      ('sch_0032_array', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', true,
       '{"${GMAIL}": ["${conn(1)}"]}'),
      ('sch_0032_empty', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', true, '{}'),
      -- GOV_PIN names a connection outside the admin pin; GOV_SOFT sits under a soft default
      ('sch_0032_pin_out', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', true,
       '{"${GOV_PIN}": ["${conn(70)}", "${conn(71)}"], "${GOV_SOFT}": ["${conn(76)}"]}'),
      -- the admin pin's own connection: a subset, though the enforced default names another
      ('sch_0032_pin_subset', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', true,
       '{"${GOV_PIN}": ["${conn(70)}"]}'),
      -- a scalar the enforced default outranks, its only key
      ('sch_0032_enforced', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', true,
       '{"${GOV_ENF}": "${conn(74)}"}'),
      -- a soft default, an admin pin on ANOTHER agent, Alice's member pin: none governs
      ('sch_0032_soft', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', true,
       '{"${GOV_SOFT}": ["${conn(76)}"], "${MINE}": ["${conn(35)}"]}'),
      -- disabled, and outranked all the same: it would be refused when re-enabled
      ('sch_0032_off_out', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', false,
       '{"${GOV_ENF}": ["${conn(74)}"]}'),
      -- the admin pin and the enforced default of GOV_OTHER live in ANOTHER space
      ('sch_0032_other_space', '${AGENT}', '${ALICE}', '${ORG}', '${SPACE}', '0 * * * *', true,
       '{"${GOV_OTHER}": ["${conn(77)}"]}');
    INSERT INTO integration_org_defaults (space_id, integration_package_id, connection_id, enforce)
      VALUES ('${SPACE}', '${DRIVE}', '${conn(4)}', false),
             ('${SPACE}', '${DEFAULTED}', '${conn(37)}', false),
             ('${SPACE}', '${UNREACH}', '${conn(39)}', false),
             ('${SPACE}', '${GOV_PIN}', '${conn(71)}', true),
             ('${SPACE}', '${GOV_ENF}', '${conn(73)}', true),
             ('${SPACE}', '${GOV_SOFT}', '${conn(75)}', false),
             ('${OTHER_SPACE}', '${GOV_OTHER}', '${conn(78)}', true);
    INSERT INTO integration_pins (space_id, package_id, integration_package_id, user_id, connection_id, created_by)
      VALUES ('${SPACE}', '${AGENT}', '${ADMIN}', NULL, '${conn(34)}', '${BOB}'),
             ('${SPACE}', '${AGENT}', '${MINE}', '${ALICE}', '${conn(36)}', '${ALICE}'),
             ('${SPACE}', '${AGENT}', '${GOV_PIN}', NULL, '${conn(70)}', '${BOB}'),
             ('${SPACE}', '${SHADOW}', '${GOV_SOFT}', NULL, '${conn(75)}', '${BOB}'),
             ('${OTHER_SPACE}', '${AGENT}', '${GOV_OTHER}', NULL, '${conn(78)}', '${BOB}');
    INSERT INTO runs
      (id, package_id, user_id, end_user_id, space_id, org_id, status, started_at, schedule_id,
       resolved_connections, connection_overrides)
    VALUES
      ${run("run_0032_recent", 2, null, { [GMAIL]: pick(1), [DRIVE]: pick(4) }, { overrides: { [GMAIL]: conn(1) } })},
      ${run("run_0032_monthly_failed", 60, "sch_0032_monthly", null)},
      ${run("run_0032_monthly", 90, "sch_0032_monthly", { [SLACK]: pick(2), [OVERRIDDEN]: pick(46, "schedule_override") })},
      ${run("run_0032_monthly_prev", 120, "sch_0032_monthly", { [SLACK]: pick(6), [OVERRIDDEN]: pick(46) })},
      ${run("run_0032_off", 90, "sch_0032_off", { [NOTION]: pick(3) })},
      ${run("run_0032_manual_old", 90, null, { [CAL]: pick(5) })},
      ${run("run_0032_array", 1, null, { [GMAIL]: [pick(1, "member_pin")] }, { overrides: { [GMAIL]: [conn(1)] } })},
      ${run("run_0032_empty", 1, null, {}, { overrides: {} })},
      ${run("run_0032_guards", 3, null, {
        [TWIN]: pick(30),
        [OWNED]: pick(32),
        [ADMIN]: pick(34),
        [MINE]: pick(35),
        [DEFAULTED]: pick(37),
        [UNREACH]: pick(38),
        [AUTH_GONE]: pick(42),
        [AUTH_KEPT]: pick(43),
        [AUTH_PIN]: pick(44),
        [AUTH_LATEST]: pick(45),
        [UNSHARED]: pick(47),
        [STALE]: pick(49),
      })},
      ${run("run_0032_leaver", 3, null, { [LEAVER]: pick(48) }, { user: CAROL })},
      ${run("run_0032_end_user", 3, null, { [EU]: pick(40) }, { user: null, endUser: END_USER })},
      ${run("run_0032_inline", 3, null, { [INLINE]: pick(41) }, { agent: SHADOW })};
  `);

  const script = await scriptSql();
  firstRunCounts = await runScript(script);
  afterFirstRun = await snapshot();
  secondRunCounts = await runScript(script);
  afterSecondRun = await snapshot();
  // A journal replay runs past the 15s default in `bunfig.toml`.
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("scripts/migration/0032 — connection sets", () => {
  it("prints the size of every section, and 0 on every 'after' line", () => {
    expect(firstRunCounts).toEqual({
      schedules_outranked_before: 3,
      schedules_outranked_emptied_before: 2,
      runs_overrides_before: 1,
      runs_resolved_before: 9,
      schedules_overrides_before: 2,
      implicit_shared_picks_before: 4,
      implicit_shared_picks_unpinned_after: 0,
      labels_to_normalize_before: 11,
      labels_emptied_before: 1,
      labels_to_normalize_after: 0,
      duplicate_labels_before: 6,
      labels_renamed: 7,
      duplicate_labels_after: 0,
      runs_overrides_after: 0,
      schedules_outranked_after: 0,
      runs_resolved_after: 0,
      schedules_overrides_after: 0,
    });
  });

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
       WHERE id IN ('sch_0032_scalar', 'sch_0032_array', 'sch_0032_empty') ORDER BY id`,
    );
    expect(schedules).toEqual([
      { id: "sch_0032_array", overrides: { [GMAIL]: [conn(1)] } },
      { id: "sch_0032_empty", overrides: {} },
      { id: "sch_0032_scalar", overrides: { [GMAIL]: [conn(1)] } },
    ]);
  });

  it("freezes an implicit shared pick as the actor's member pin — and only where the old fallback would still make it and no layer above it decides", async () => {
    // Pinned: GMAIL (a run of the last 30 days); SLACK (the latest RESOLVED
    // run of an enabled monthly schedule, 90 days old — not the newer failed
    // one, not the older one naming a connection since gone dead); UNREACH (its
    // org default names a connection Alice cannot reach); AUTH_KEPT (its auth
    // is declared, and only a `beta` version pins another).
    //
    // Not pinned, one clause each: NOTION (disabled schedule), CAL (old manual
    // run), DRIVE (departed owner), TWIN (a second healthy shared connection),
    // OWNED (a healthy connection of Alice's own), ADMIN (an admin pin), MINE
    // (Alice's own pin, left as it was), DEFAULTED (a reachable org default),
    // EU (an end-user's run), INLINE (an inline run's shadow agent), AUTH_GONE
    // (the manifest no longer declares its auth), AUTH_PIN / AUTH_LATEST (the
    // agent's draft / `latest` manifest pins another auth), OVERRIDDEN (the
    // schedule's latest run bound it through its override; only an OLDER run
    // of that schedule leaned on the fallback), UNSHARED (Bob's healthy
    // connection, not shared), LEAVER (the run's actor, Carol, left the
    // organization), STALE (the shared connection needs reconnecting).
    expect(await memberPins()).toEqual([
      { integration: AUTH_KEPT, user: ALICE, connection: conn(43) },
      { integration: GMAIL, user: ALICE, connection: conn(1) },
      { integration: MINE, user: ALICE, connection: conn(36) },
      { integration: SLACK, user: ALICE, connection: conn(2) },
      { integration: UNREACH, user: ALICE, connection: conn(38) },
    ]);
    const { rows } = await pg.query<{ created_by: string }>(
      "SELECT created_by FROM integration_pins WHERE user_id IS NOT NULL",
    );
    expect(rows.every((r) => r.created_by === ALICE)).toBe(true);
    const admin = await pg.query<{ integration: string; connection: string }>(
      `SELECT integration_package_id AS integration, connection_id::text AS connection
       FROM integration_pins WHERE user_id IS NULL AND integration_package_id = '${ADMIN}'`,
    );
    expect(admin.rows).toEqual([{ integration: ADMIN, connection: conn(34) }]);
  });

  it("drops a schedule override key the admin pin or the enforced org default outranks — the old cascade ignored it — and keeps a subset and what no governing layer outranks", async () => {
    const { rows } = await pg.query<{ id: string; overrides: unknown; enabled: boolean }>(
      `SELECT id, connection_overrides AS overrides, enabled FROM package_schedules
       WHERE id IN ('sch_0032_pin_out', 'sch_0032_pin_subset', 'sch_0032_enforced', 'sch_0032_soft',
                    'sch_0032_off_out', 'sch_0032_other_space')
       ORDER BY id`,
    );
    expect(rows).toEqual([
      // the only key dropped: NULL, the service's "no overrides"; still enabled, governance binds
      { id: "sch_0032_enforced", overrides: null, enabled: true },
      // a disabled schedule is dropped the same, and stays disabled
      { id: "sch_0032_off_out", overrides: null, enabled: false },
      // another space's admin pin and enforced default govern that space only: kept verbatim
      { id: "sch_0032_other_space", overrides: { [GOV_OTHER]: [conn(77)] }, enabled: true },
      // the outranked key dropped, the soft default's kept
      { id: "sch_0032_pin_out", overrides: { [GOV_SOFT]: [conn(76)] }, enabled: true },
      // the admin pin governs, not the enforced default below it
      { id: "sch_0032_pin_subset", overrides: { [GOV_PIN]: [conn(70)] }, enabled: true },
      // a soft default, another agent's admin pin, a member pin: kept verbatim
      {
        id: "sch_0032_soft",
        overrides: { [GOV_SOFT]: [conn(76)], [MINE]: [conn(35)] },
        enabled: true,
      },
    ]);
  });

  it("normalizes a label only as far as the label rule requires: line breaks to spaces, forbidden characters dropped, ends trimmed, cut to 80 UTF-16 units", async () => {
    expect(await labelOf(conn(50))).toBe("Work Mail");
    // BEL, DEL and a C1 control
    expect(await labelOf(conn(51))).toBe("OpsBot");
    // a bidi override
    expect(await labelOf(conn(52))).toBe("gnp.exe");
    // a zero-width space and a soft hyphen
    expect(await labelOf(conn(53))).toBe("TeamA");
    // the ends are trimmed; the inner run, NBSP included, is legal and kept
    expect(await labelOf(conn(55))).toBe("Sales \u00A0  Team");
    // a tag character (above U+FFFF) and a BOM
    expect(await labelOf(conn(58))).toBe("TagX");
    // the cut lands on the space the tab became, and the right-trim drops it
    expect(await labelOf(conn(59))).toBe("a".repeat(79));
    // 40 emoji are 80 units: the NEL's space and the "z" fall past the cut
    expect(await labelOf(conn(60))).toBe(EMOJI);
    expect(await labelOf(conn(61))).toBe("Clean one");
    // Legal labels are kept verbatim: collapsing whitespace would merge each
    // pair into one label and force a needless " (2)".
    expect(await labelOf(conn(62))).toBe("Two  spaces");
    expect(await labelOf(conn(63))).toBe("Two spaces");
    expect(await labelOf(conn(64))).toBe("No\u00A0break");
    expect(await labelOf(conn(65))).toBe("No break");
  });

  it("leaves every label one the label rule accepts, whichever forbidden code point it held", async () => {
    // the eight line breaks became spaces, every other forbidden code point dropped
    expect(await labelOf(conn(66))).toBe(`Hid${" ".repeat(8)}den`);
    const { rows } = await pg.query<{ label: string }>(
      "SELECT label FROM integration_connections WHERE label IS NOT NULL AND label <> ''",
    );
    expect(rows.length).toBeGreaterThan(50);
    const problem = (label: string) =>
      connectionLabelProblem(label) ?? (label.length > CONNECTION_LABEL_MAX ? "too long" : null);
    expect(rows.map((r) => [r.label, problem(r.label)]).filter(([, p]) => p !== null)).toEqual([]);
  });

  it("empties a whitespace-only label to NULL, and dedupes labels normalization made equal", async () => {
    expect(await labelOf(conn(54))).toBeNull();
    expect(await labelOf(conn(56))).toBe("Prod");
    expect(await labelOf(conn(57))).toBe("Prod (2)");
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

  it("changes nothing on a second run, and finds nothing to do", () => {
    expect(afterSecondRun).toBe(afterFirstRun);
    expect(Object.entries(secondRunCounts).filter(([, n]) => n !== 0)).toEqual([]);
  });

  // "Nothing was written" is the one transaction's to guarantee: PGlite runs the
  // whole string as one block, so this test cannot tell it apart from its own
  // ROLLBACK. It proves the refusal, and restores the rows for the tests after it.
  it("refuses a value SHAPE would wrap that is neither a string override nor an object snapshot", async () => {
    await pg.exec(`BEGIN;
      UPDATE runs SET connection_overrides = '{"${GMAIL}": 42}', resolved_connections = '{"${GMAIL}": null}'
        WHERE id = 'run_0032_empty';
      UPDATE package_schedules SET connection_overrides = '{"${GMAIL}": {"id": "${conn(1)}"}}'
        WHERE id = 'sch_0032_empty';`);
    let refusal: unknown;
    try {
      await pg.exec(await scriptSql());
    } catch (error) {
      refusal = error;
    } finally {
      await pg.exec("ROLLBACK");
    }
    expect((refusal as Error | undefined)?.message).toContain(
      "0032: 1 runs.connection_overrides, 1 runs.resolved_connections and 1 package_schedules.connection_overrides value(s) are neither",
    );
    expect(await snapshot()).toBe(afterSecondRun);
  });

  it("leaves 0077 applicable: its backfill mints past every 'Connexion N' and the unique index lands", async () => {
    await pg.transaction(async (tx) => {
      const source = await Bun.file(MIGRATION_0077).text();
      await tx.exec(source.replaceAll("--> statement-breakpoint", ""));
    });
    expect(await labelOf(conn(15))).toBe("Connexion 4");
    expect(await labelOf(conn(16))).toBe("Connexion 5");
    expect(await labelOf(conn(17))).toBe("Connexion 6");
    // the label normalization emptied
    expect(await labelOf(conn(54))).toBe("Connexion 1");
    const { rows } = await pg.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_integration_conn_label'",
    );
    expect(rows).toEqual([{ indexname: "idx_integration_conn_label" }]);
    const pins = await pg.query<{ ids: string[] }>(
      `SELECT connection_ids::text[] AS ids FROM integration_pins
       WHERE user_id IS NOT NULL ORDER BY integration_package_id`,
    );
    expect(pins.rows).toEqual([
      { ids: [conn(43)] },
      { ids: [conn(1)] },
      { ids: [conn(36)] },
      { ids: [conn(2)] },
      { ids: [conn(38)] },
    ]);
  });
});
