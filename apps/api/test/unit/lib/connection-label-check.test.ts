// SPDX-License-Identifier: Apache-2.0

/**
 * The CHECK `integration_connections_label_normalized` spells the label rule in SQL, so it can
 * drift from `connectionLabelProblem` + `CONNECTION_LABEL_MAX` (and `isHiddenCodePoint` beneath
 * them): read it off the catalog the whole journal builds and hold it to the TS rule, code point
 * by code point.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { journalPGlite } from "../../helpers/journal.ts";
import { CONNECTION_LABEL_MAX, connectionLabelProblem } from "../../../src/lib/connection-label.ts";

const cp = (n: number) => String.fromCodePoint(n);
const accepted = (label: string) =>
  connectionLabelProblem(label) === null && label.length <= CONNECTION_LABEL_MAX;

let pg: PGlite;
/** The live CHECK expression, `label` its only column. */
let predicate: string;

beforeAll(async () => {
  pg = await journalPGlite();
  const { rows } = await pg.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'integration_connections'::regclass
        AND conname = 'integration_connections_label_normalized'`,
  );
  predicate = rows[0]!.definition.replace(/^CHECK /, "");
}, 300_000);

afterAll(async () => {
  await pg.close();
});

/** The code points the CHECK refuses in the label `wrap` builds from `g.cp`. */
async function refusedBySql(wrap: string): Promise<number[]> {
  const { rows } = await pg.query<{ cp: number }>(
    `SELECT g.cp FROM generate_series(1, 1114111) AS g(cp)
     CROSS JOIN LATERAL (SELECT ${wrap} AS label) t
     WHERE g.cp NOT BETWEEN 55296 AND 57343 AND NOT ${predicate}
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

describe("integration_connections_label_normalized — the TS label rule in SQL", () => {
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
    const emoji = cp(0x1f600);
    const cases: [string, boolean][] = [
      ["", false],
      ["a".repeat(80), true],
      ["a".repeat(81), false],
      [emoji.repeat(40), true],
      [`${emoji.repeat(40)}a`, false],
      [`${"a".repeat(78)}${emoji}`, true],
      [`${"a".repeat(79)}${emoji}`, false],
      [`${"a".repeat(79)}${cp(0xe9)}`, true],
      [`${"a".repeat(80)}${cp(0xe9)}`, false],
    ];
    const { rows } = await pg.query<{ ok: boolean }>(
      `SELECT ${predicate} AS ok FROM unnest($1::text[]) WITH ORDINALITY AS t(label, i) ORDER BY i`,
      [cases.map(([label]) => label)],
    );
    expect(rows.map((r) => r.ok)).toEqual(cases.map(([, ok]) => ok));
    expect(cases.map(([label]) => accepted(label))).toEqual(cases.map(([, ok]) => ok));
  });
});
