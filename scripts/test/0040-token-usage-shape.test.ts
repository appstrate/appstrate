// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0040` against the test database: a run whose stored `token_usage` `parseTokenUsage`
 * keeps only in part is listed, left as it is in a dry run, and rewritten to what it keeps with
 * `--apply`; a run malformed as a whole is listed, never touched, and fails the run in both modes.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { runTokenUsageShape } from "../migration/0040-token-usage-shape.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedPackage, seedRun } from "../../apps/api/test/helpers/seed.ts";

const AGENT = "@mig0040/agent";
const WELL_FORMED = '{"input_tokens":10,"tiers":[{"input_tokens_above":1,"input_tokens":4}]}';

let ctx: TestContext;
const lines: string[] = [];
const run = (apply: boolean) => runTokenUsageShape({ apply, out: (line) => lines.push(line) });

/** A run whose `token_usage` is the given JSON text (SQL NULL when null). */
async function runWithUsage(json: string | null): Promise<string> {
  const row = await seedRun({ packageId: AGENT, orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
  if (json !== null) {
    await db.execute(`UPDATE runs SET token_usage = '${json}'::jsonb WHERE id = '${row.id}'`);
  }
  return row.id;
}

async function stored(id: string): Promise<unknown> {
  const [row] = await db.select({ usage: runs.tokenUsage }).from(runs).where(eq(runs.id, id));
  return row!.usage;
}

describe("0040 — token_usage brought to the token-usage rule", () => {
  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "mig0040" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId });
  });

  it("lists in a dry run, rewrites with --apply, and leaves a malformed row alone", async () => {
    const none = await runWithUsage(null);
    const wellFormed = await runWithUsage(WELL_FORMED);
    const extraKey = await runWithUsage('{"input_tokens":10,"cost":0.2}');
    const badBand = await runWithUsage('{"output_tokens":3,"tiers":[{"input_tokens_above":0}]}');
    const fractional = await runWithUsage('{"input_tokens":1.5,"output_tokens":2}');

    expect(await run(false)).toBe(1);
    expect(lines.filter((l) => l.startsWith("  rewrite ")).length).toBe(2);
    expect(lines.filter((l) => l.startsWith("  MALFORMED "))).toEqual([
      `  MALFORMED mig0040 ${fractional}: {"input_tokens": 1.5, "output_tokens": 2}`,
    ]);
    expect(lines.at(-2)).toBe("4 run(s) with a token_usage, 2 rewritten, 1 malformed left as is");
    expect(await stored(extraKey)).toEqual({ input_tokens: 10, cost: 0.2 });

    lines.length = 0;
    expect(await run(true)).toBe(1);
    expect(lines.at(-1)).toBe("0040: APPLIED — committed.");
    expect({
      none: await stored(none),
      wellFormed: await stored(wellFormed),
      extraKey: await stored(extraKey),
      badBand: await stored(badBand),
      fractional: await stored(fractional),
    }).toEqual({
      none: null,
      wellFormed: JSON.parse(WELL_FORMED),
      extraKey: { input_tokens: 10 },
      badBand: { output_tokens: 3 },
      fractional: { input_tokens: 1.5, output_tokens: 2 },
    });

    lines.length = 0;
    expect(await run(true)).toBe(1);
    expect(lines.at(-2)).toBe("4 run(s) with a token_usage, 0 rewritten, 1 malformed left as is");
  });

  it("counts a value that is not an object as malformed", async () => {
    await runWithUsage("null");
    await runWithUsage("[1]");
    expect(await run(false)).toBe(1);
    expect(lines.at(-2)).toBe("2 run(s) with a token_usage, 0 rewritten, 2 malformed left as is");
  });

  it("exits 0 when every row conforms", async () => {
    await runWithUsage(WELL_FORMED);
    expect(await run(true)).toBe(0);
  });
});
