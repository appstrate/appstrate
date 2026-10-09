// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0040` against the test database: every run whose stored `token_usage` is not what
 * `parseTokenUsage` keeps of it is listed, left as it is in a dry run, and rewritten to that with
 * `--apply` — NULL when malformed as a whole; a second run finds nothing.
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

  it("lists in a dry run, rewrites with --apply, and finds nothing the second time", async () => {
    const none = await runWithUsage(null);
    const wellFormed = await runWithUsage(WELL_FORMED);
    const extraKey = await runWithUsage('{"input_tokens":10,"cost":0.2}');
    const badBand = await runWithUsage('{"output_tokens":3,"tiers":[{"input_tokens_above":0}]}');
    const jsonNull = await runWithUsage("null");
    const array = await runWithUsage("[1]");
    const fractional = await runWithUsage('{"input_tokens":1.5,"output_tokens":2}');

    await run(false);
    expect(lines.filter((l) => l.startsWith("  rewrite ")).length).toBe(5);
    expect(lines.at(-2)).toBe("6 run(s) with a token_usage, 5 rewritten (3 to NULL)");
    expect(await stored(extraKey)).toEqual({ input_tokens: 10, cost: 0.2 });

    lines.length = 0;
    await run(true);
    expect(lines.at(-1)).toBe("0040: APPLIED — committed.");
    expect({
      none: await stored(none),
      wellFormed: await stored(wellFormed),
      extraKey: await stored(extraKey),
      badBand: await stored(badBand),
      jsonNull: await stored(jsonNull),
      array: await stored(array),
      fractional: await stored(fractional),
    }).toEqual({
      none: null,
      wellFormed: JSON.parse(WELL_FORMED),
      extraKey: { input_tokens: 10 },
      badBand: { output_tokens: 3 },
      jsonNull: null,
      array: null,
      fractional: null,
    });

    lines.length = 0;
    await run(true);
    expect(lines.at(-2)).toBe("3 run(s) with a token_usage, 0 rewritten (0 to NULL)");
  });
});
