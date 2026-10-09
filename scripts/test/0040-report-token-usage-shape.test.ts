// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0040` against the test database: the report lists every run whose stored
 * `token_usage` breaks the token-usage rule, with each problem it carries, and skips the runs
 * holding none or a well-formed one.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { readSnapshot, report } from "../migration/0040-report-token-usage-shape.ts";
import { db } from "@appstrate/db/client";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedPackage, seedRun } from "../../apps/api/test/helpers/seed.ts";

const AGENT = "@mig0040/agent";

let ctx: TestContext;

const run = (query: string) =>
  db.execute(query).then((r) => (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows));

/** A run of the test org whose `token_usage` is the given JSON text (SQL NULL when null). */
async function runWithUsage(json: string | null): Promise<string> {
  const row = await seedRun({ packageId: AGENT, orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
  if (json !== null) {
    await run(`UPDATE runs SET token_usage = '${json}'::jsonb WHERE id = '${row.id}'`);
  }
  return row.id;
}

describe("0040 — token_usage shape report", () => {
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mig0040" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId });
  });

  it("lists each run breaking the rule with its problems, and the totals", async () => {
    await runWithUsage(null);
    await runWithUsage('{"input_tokens":10,"output_tokens":2}');
    await runWithUsage('{"input_tokens":10,"tiers":[{"input_tokens_above":1,"input_tokens":4}]}');
    const jsonNull = await runWithUsage("null");
    const array = await runWithUsage("[1]");
    const extra = await runWithUsage('{"input_tokens":10,"cost":0.2}');
    const fractional = await runWithUsage('{"input_tokens":1.5,"output_tokens":-1}');
    const nullCounter = await runWithUsage('{"output_tokens":null}');
    const tiers = await runWithUsage('{"vendor":1,"tiers":[{"input_tokens_above":0}]}');

    const lines = report(await readSnapshot(run));

    expect(lines.slice(0, -1).sort()).toEqual(
      [
        `mig0040 ${jsonNull}: not_object`,
        `mig0040 ${array}: not_object`,
        `mig0040 ${extra}: unknown_keys`,
        `mig0040 ${fractional}: bad_counters`,
        `mig0040 ${nullCounter}: bad_counters`,
        `mig0040 ${tiers}: unknown_keys, bad_tiers`,
      ].sort(),
    );
    expect(lines.at(-1)).toBe(
      "6 of 8 run(s) with a token_usage break the rule (expected 0): " +
        "2 not_object, 2 unknown_keys, 2 bad_counters, 1 bad_tiers.",
    );
  });

  it("reports nothing to repair on well-formed usage", async () => {
    await runWithUsage('{"input_tokens":10,"output_tokens":2}');
    expect(report(await readSnapshot(run))).toEqual([
      "0 of 1 run(s) with a token_usage break the rule (expected 0): " +
        "0 not_object, 0 unknown_keys, 0 bad_counters, 0 bad_tiers.",
    ]);
  });
});
