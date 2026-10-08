// SPDX-License-Identifier: Apache-2.0

/**
 * Drizzle `0083`'s label CHECK against the TS label rule (`connectionLabelProblem` +
 * `CONNECTION_LABEL_MAX`), and `scripts/migration/0038-normalize-connection-labels.sql` on a
 * private PGlite replayed to `0082` — the schema it runs against, one migration short of `0083`,
 * which is also the only place a label outside the rule is seedable. `0083` is refused there first,
 * then the script runs twice and `0083` lands on top.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { journalPGlite } from "../helpers/journal.ts";
import { CONNECTION_LABEL_MAX, connectionLabelProblem } from "../../src/lib/connection-label.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = `${REPO_ROOT}/scripts/migration/0038-normalize-connection-labels.sql`;
const MIGRATION_0083 = `${REPO_ROOT}/packages/db/drizzle/0083_integration_connections_label_normalized.sql`;
const REPLAY_THROUGH = "0082_connection_variables";

const ORG = "e0000000-0000-4000-8000-00000000d038";
const SPACE = "spc_d0380000-0000-4000-8000-000000000001";
const ALICE = "usr_0038_alice";
const GMAIL = "@acme0038/gmail";
const SLACK = "@acme0038/slack";

const conn = (n: number) => `d0380000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cp = (n: number) => String.fromCodePoint(n);
const [TAB, LF, SHY, ZWSP, ZWJ, RLO, NBSP, BOM] = [
  0x09, 0x0a, 0xad, 0x200b, 0x200d, 0x202e, 0xa0, 0xfeff,
].map(cp);
/** 40 code points, 80 UTF-16 units — the unit `CONNECTION_LABEL_MAX` counts in. */
const EMOJI = cp(0x1f600).repeat(40);
/** Every code point `connectionLabelProblem` forbids, NUL aside (a `text` cannot hold it). */
const FORBIDDEN = (() => {
  let out = "";
  for (let c = 1; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (connectionLabelProblem(`a${cp(c)}a`)?.includes("control")) out += cp(c);
  }
  return out;
})();

const accepted = (label: string) =>
  connectionLabelProblem(label) === null && label.length <= CONNECTION_LABEL_MAX;

/**
 * [connection, integration, label seeded, created_at, label after `0038`]. The GMAIL group holds
 * 18 rows, so a deduped base has room for 80 − " (37)" = 75 units.
 */
const ROWS: [number, string, string, string, string][] = [
  // a kept label never yields, even to an older rewrite
  [1, GMAIL, "Prod", "2026-03-01", "Prod"],
  [2, GMAIL, `Prod${ZWJ}`, "2026-01-01", "Prod (2)"],
  [3, GMAIL, ` Prod`, "2026-01-02", "Prod (3)"],
  // the older rewrite keeps the plain label; the next "(n)" skips one already held
  [4, GMAIL, `Team${SHY}`, "2026-01-01", "Team"],
  [5, GMAIL, `Team${TAB}`, "2026-01-02", "Team (3)"],
  [6, GMAIL, "Team (2)", "2026-01-03", "Team (2)"],
  // emptied → "Connexion N" past every kept or normalized "Connexion <n>"
  [7, GMAIL, `  ${TAB} `, "2026-01-01", "Connexion 7"],
  [8, GMAIL, "Connexion 4", "2026-01-01", "Connexion 4"],
  [9, GMAIL, `Connexion 6${ZWSP}`, "2026-01-01", "Connexion 6"],
  // cut to 80 UTF-16 units, an astral code point counting two
  [10, GMAIL, "a".repeat(81), "2026-01-01", "a".repeat(80)],
  [11, GMAIL, `${EMOJI}z`, "2026-01-01", EMOJI],
  [12, GMAIL, `${"x".repeat(80)}${ZWSP}`, "2026-01-02", `${"x".repeat(75)} (2)`],
  [13, GMAIL, "x".repeat(80), "2026-01-01", "x".repeat(80)],
  [14, GMAIL, `${RLO}gnp.exe`, "2026-01-01", "gnp.exe"],
  // line breaks become spaces, every other forbidden code point is dropped
  [15, GMAIL, `Hid${FORBIDDEN}den`, "2026-01-01", `Hid${" ".repeat(8)}den`],
  [16, GMAIL, `Work${LF}Mail`, "2026-01-01", "Work Mail"],
  // legal labels are verbatim: inner runs and NBSP included
  [17, GMAIL, "Two  spaces", "2026-01-01", "Two  spaces"],
  [18, GMAIL, `No${NBSP}break`, "2026-01-01", `No${NBSP}break`],
  // two rewrites colliding with each other, in another group
  [20, SLACK, `Same${ZWSP}`, "2026-01-01", "Same"],
  [21, SLACK, `Same${BOM}`, "2026-01-02", "Same (2)"],
];

const migration = await Bun.file(MIGRATION_0083).text();
const ADDED = /"integration_connections_label_normalized" CHECK \((.*)\);$/m;
const PREDICATE = ADDED.exec(migration)![1]!;

let pg: PGlite;
let refusedBefore: Error | null;
let firstRun: ScriptOutput;
let secondRun: ScriptOutput;
let afterFirstRun = "";
let afterSecondRun = "";

interface ScriptOutput {
  counts: Record<string, number>;
  listed: { connection_id: string; label_before: string; label_after: string }[];
}

async function runScript(): Promise<ScriptOutput> {
  const results = await pg.exec(await Bun.file(SCRIPT).text());
  const out: ScriptOutput = { counts: {}, listed: [] };
  for (const { rows } of results) {
    for (const row of rows as Record<string, unknown>[]) {
      if ("label_after" in row) out.listed.push(row as never);
      for (const [key, value] of Object.entries(row)) {
        if (key.startsWith("labels_")) out.counts[key] = Number(value);
      }
    }
  }
  return out;
}

async function snapshot(): Promise<string> {
  const { rows } = await pg.query(
    "SELECT id, label, updated_at FROM integration_connections ORDER BY id",
  );
  return JSON.stringify(rows);
}

/** `0083` in one transaction; resolves to its refusal, or `null` when it applied. */
async function apply0083(): Promise<Error | null> {
  try {
    await pg.transaction(async (tx) => {
      await tx.exec(migration.replaceAll("--> statement-breakpoint", ""));
    });
    return null;
  } catch (error) {
    return error as Error;
  }
}

/** The code points the CHECK refuses in `wrap(code point)`, by the migration's own predicate. */
async function refusedBySql(wrap: string): Promise<number[]> {
  const { rows } = await pg.query<{ cp: number }>(
    `SELECT g.cp FROM generate_series(1, 1114111) AS g(cp)
     CROSS JOIN LATERAL (SELECT ${wrap} AS label) t
     WHERE g.cp NOT BETWEEN 55296 AND 57343 AND NOT (${PREDICATE})
     ORDER BY g.cp`,
  );
  return rows.map((r) => r.cp);
}

function refusedByTs(wrap: (ch: string) => string): number[] {
  const out: number[] = [];
  for (let c = 1; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (!accepted(wrap(cp(c)))) out.push(c);
  }
  return out;
}

beforeAll(async () => {
  pg = await journalPGlite({ through: REPLAY_THROUGH });
  await pg.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Zero38', 'zero-38');
    INSERT INTO spaces (id, org_id, name, is_default) VALUES ('${SPACE}', '${ORG}', 'Default', true);
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
      ('${ALICE}', 'Alice', 'a-0038@example.com', true, now(), now());
    INSERT INTO org_members (org_id, user_id, role) VALUES ('${ORG}', '${ALICE}', 'member');
    INSERT INTO packages (id, type) VALUES ('${GMAIL}', 'integration'), ('${SLACK}', 'integration');
  `);
  for (const [n, integration, label, at] of ROWS) {
    await pg.query(
      `INSERT INTO integration_connections
         (id, integration_package_id, auth_key, account_id, space_id, user_id,
          credentials_encrypted, label, created_at, updated_at)
       VALUES ($1, $2, 'primary', $3, $4, $5, 'x', $6, $7, $7)`,
      [conn(n), integration, `acct-${n}`, SPACE, ALICE, label, at],
    );
  }

  refusedBefore = await apply0083();
  firstRun = await runScript();
  afterFirstRun = await snapshot();
  secondRun = await runScript();
  afterSecondRun = await snapshot();
  // A journal replay runs past the suite's 15s per-test timeout (`--timeout`).
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("drizzle 0083 — the label CHECK is the TS label rule", () => {
  it("guards with the predicate it adds, and 0038's pre-flight counts with it too", async () => {
    expect(migration).toContain(`WHERE NOT (${PREDICATE}))`);
    expect(await Bun.file(SCRIPT).text()).toContain(`WHERE NOT (${PREDICATE});`);
  });

  it("refuses, alone or at either end, exactly the code points connectionLabelProblem refuses", async () => {
    for (const [sql, ts] of [
      ["'a' || chr(g.cp) || 'a'", (ch: string) => `a${ch}a`],
      ["chr(g.cp) || 'a'", (ch: string) => `${ch}a`],
      ["'a' || chr(g.cp)", (ch: string) => `a${ch}`],
      ["chr(g.cp)", (ch: string) => ch],
    ] as const) {
      expect(await refusedBySql(sql)).toEqual(refusedByTs(ts));
    }
  }, 120_000);

  it("refuses the empty label, and counts length in UTF-16 units", async () => {
    const cases: [string, boolean][] = [
      ["", false],
      ["a".repeat(80), true],
      ["a".repeat(81), false],
      [EMOJI, true],
      [`${EMOJI}a`, false],
      [`${"a".repeat(78)}${cp(0x1f600)}`, true],
      [`${"a".repeat(79)}${cp(0x1f600)}`, false],
      [`${"a".repeat(79)}${cp(0xe9)}`, true],
      [`${"a".repeat(80)}${cp(0xe9)}`, false],
    ];
    const { rows } = await pg.query<{ ok: boolean }>(
      `SELECT (${PREDICATE}) AS ok FROM unnest($1::text[]) WITH ORDINALITY AS t(label, i) ORDER BY i`,
      [cases.map(([label]) => label)],
    );
    expect(rows.map((r) => r.ok)).toEqual(cases.map(([, ok]) => ok));
    expect(cases.map(([label]) => accepted(label))).toEqual(cases.map(([, ok]) => ok));
  });

  it("refuses the batch on a label outside the rule, naming 0038", () => {
    expect(refusedBefore?.message).toContain(
      "scripts/migration/0038-normalize-connection-labels.sql",
    );
  });
});

describe("scripts/migration/0038 — labels normalized, deduped, minted", () => {
  it("prints the size of every step, and 0 after", () => {
    expect(firstRun.counts).toEqual({
      labels_to_normalize_before: 14,
      labels_emptied_before: 1,
      labels_normalized: 8,
      labels_deduped: 5,
      labels_minted: 1,
      labels_to_normalize_after: 0,
    });
  });

  it("rewrites only the labels the rule refuses, and lists each with its label before and after", async () => {
    const { rows } = await pg.query<{ id: string; label: string }>(
      "SELECT id, label FROM integration_connections ORDER BY id",
    );
    expect(rows).toEqual(ROWS.map(([n, , , , after]) => ({ id: conn(n), label: after })));
    const listed = firstRun.listed.map((r) => [r.connection_id, r.label_before, r.label_after]);
    const rewritten = ROWS.filter(([, , before, , after]) => before !== after).map(
      ([n, , before, , after]) => [conn(n), before, after],
    );
    expect(listed.sort()).toEqual(rewritten);
    expect(rows.filter((r) => !accepted(r.label))).toEqual([]);
  });

  it("changes nothing on a second run, and finds nothing to do", () => {
    expect(afterSecondRun).toBe(afterFirstRun);
    expect(secondRun.listed).toEqual([]);
    expect(Object.values(secondRun.counts).filter((n) => n !== 0)).toEqual([]);
  });

  it("leaves 0083 applicable, whose CHECK then refuses a label outside the rule", async () => {
    expect(await apply0083()).toBeNull();
    const rename = "UPDATE integration_connections SET label = $1 WHERE id = $2";
    for (const label of ["", " a", `a${ZWSP}`, "a".repeat(81)]) {
      let refusal: unknown;
      try {
        await pg.query(rename, [label, conn(17)]);
      } catch (error) {
        refusal = error;
      }
      expect((refusal as Error | undefined)?.message).toContain(
        "integration_connections_label_normalized",
      );
    }
  });
});
