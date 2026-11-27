// SPDX-License-Identifier: Apache-2.0

/**
 * `recordToolSnapshot` / `readToolSnapshots`: the merge of a listing into the target's row, the
 * definition budget, and two listings of one target racing.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { OBSERVED_TOOLS_MAX_COUNT } from "@appstrate/core/sidecar-types";
import { toolDefinitionFingerprint } from "@appstrate/mcp-transport";
import { integrationToolSnapshots } from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { oversizedListing, tool } from "../../helpers/tool-policy.ts";
import { seedAgent } from "../../helpers/seed.ts";
import { recordToolSnapshot } from "../../../src/services/integration-tool-snapshots.ts";
import { readToolSnapshots } from "../../../src/services/integration-tool-snapshot-reads.ts";

describe("integration tool snapshots", () => {
  let ctx: TestContext;
  let target: { orgId: string; packageId: string; connectionId: null };

  const read = async () => {
    const [snapshot] = await readToolSnapshots({
      orgId: target.orgId,
      packageId: target.packageId,
      connectionIds: [null],
    });
    return snapshot;
  };

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    const pkg = await seedAgent({ orgId: ctx.orgId, id: "@testorg/remote", type: "integration" });
    target = { orgId: ctx.orgId, packageId: pkg.id, connectionId: null };
  });

  it("stamps a new tool first_seen_at with no change, and fingerprints the raw tool", async () => {
    const listed = tool("search");
    const result = await recordToolSnapshot({ ...target, tools: [listed], truncated: false });

    expect(result).toEqual({ added: ["search"], changed: [] });
    const entry = (await read())?.tools[0];
    expect(entry).toMatchObject({
      name: "search",
      fingerprint: toolDefinitionFingerprint(listed),
      changed_at: null,
      definition: { name: "search" },
    });
    expect(entry?.first_seen_at).toBeString();
  });

  it("sets changed_at when the definition changed, and keeps first_seen_at", async () => {
    await recordToolSnapshot({ ...target, tools: [tool("a"), tool("b")], truncated: false });
    const before = (await read())!.tools;

    const result = await recordToolSnapshot({
      ...target,
      tools: [tool("a"), tool("b", "Now it deletes things")],
      truncated: false,
    });

    expect(result).toEqual({ added: [], changed: ["b"] });
    const [a, b] = (await read())!.tools;
    expect(a).toEqual(before[0]!);
    expect(b?.first_seen_at).toBe(before[1]!.first_seen_at);
    expect(b?.changed_at).toBeString();
    expect(b?.fingerprint).not.toBe(before[1]!.fingerprint);
  });

  it("keeps the tools a truncated listing did not return, and drops them on a full one", async () => {
    await recordToolSnapshot({ ...target, tools: [tool("a"), tool("b")], truncated: false });

    await recordToolSnapshot({ ...target, tools: [tool("a"), tool("c")], truncated: true });
    expect((await read())!.tools.map((t) => t.name)).toEqual(["a", "c", "b"]);
    expect((await read())!.truncated).toBe(true);

    await recordToolSnapshot({ ...target, tools: [tool("a"), tool("c")], truncated: false });
    expect((await read())!.tools.map((t) => t.name)).toEqual(["a", "c"]);
  });

  it("keeps only the identity of the tools past 512 KiB of definitions", async () => {
    // Descriptions are cut by the sanitiser: many tools are needed to pass the budget.
    await recordToolSnapshot({ ...target, tools: oversizedListing(), truncated: false });

    const stored = (await read())!.tools;
    expect(stored).toHaveLength(400);
    expect(stored[0]!.definition).not.toBeNull();
    expect(stored.at(-1)!.definition).toBeNull();
    expect(stored.at(-1)!.fingerprint).toBeString();
  });

  // PGlite serialises its queries: this proves the merge and the single row, not the `FOR UPDATE`
  // that orders two listings on a real PostgreSQL.
  it("merges two truncated listings issued together into one row", async () => {
    await Promise.all(
      [["a"], ["b"]].map((names) =>
        recordToolSnapshot({ ...target, tools: names.map((n) => tool(n!)), truncated: true }),
      ),
    );

    expect(await db.select().from(integrationToolSnapshots)).toHaveLength(1);
    expect((await read())!.tools.map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  it("moves only listed_at when the same fingerprints are listed again", async () => {
    await recordToolSnapshot({ ...target, tools: [tool("a"), tool("b")], truncated: false });
    const first = (await read())!;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await recordToolSnapshot({
      ...target,
      tools: [tool("b"), tool("a")],
      truncated: false,
    });

    expect(result).toEqual({ added: [], changed: [] });
    const second = (await read())!;
    expect(second.listedAt.getTime()).toBeGreaterThan(first.listedAt.getTime());
    // Untouched, order included: the rows were not rewritten.
    expect(second.tools).toEqual(first.tools);
  });

  it("rewrites the row when only the truncated flag differs", async () => {
    await recordToolSnapshot({ ...target, tools: [tool("a")], truncated: false });
    await recordToolSnapshot({ ...target, tools: [tool("a")], truncated: true });
    expect((await read())!.truncated).toBe(true);
  });

  it("caps what a truncated listing keeps to the observed-tools maximum, newest first", async () => {
    const many = Array.from({ length: OBSERVED_TOOLS_MAX_COUNT }, (_, i) => tool(`old${i}`));
    await recordToolSnapshot({ ...target, tools: many, truncated: false });
    await recordToolSnapshot({ ...target, tools: [tool("fresh")], truncated: true });

    const stored = (await read())!.tools;
    expect(stored).toHaveLength(OBSERVED_TOOLS_MAX_COUNT);
    expect(stored[0]!.name).toBe("fresh");
  });
});
