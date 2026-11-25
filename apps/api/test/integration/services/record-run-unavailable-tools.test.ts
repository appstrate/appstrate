// SPDX-License-Identifier: Apache-2.0

/**
 * `recordRunUnavailableTools`: one call may name tools of several integrations, an integration
 * keeps a bounded number of entries, and a run of another organization is never written.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { runs } from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";
import { recordRunUnavailableTools } from "../../../src/services/state/runs.ts";

type Entry = { integration_id: string; name: string; reason: string };

describe("recordRunUnavailableTools", () => {
  let ctx: TestContext;
  let runId: string;

  const recorded = async (): Promise<Entry[]> => {
    const [row] = await db.select({ metadata: runs.metadata }).from(runs).where(eq(runs.id, runId));
    return ((row?.metadata ?? {}) as { unavailable_tools?: Entry[] }).unavailable_tools ?? [];
  };

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "unavail" });
    const pkg = await seedPackage({
      id: "@unavail/agent",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
    runId = (
      await seedRun({
        packageId: pkg.id,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        status: "running",
      })
    ).id;
  });

  it("records the tools of two integrations given in one call", async () => {
    await recordRunUnavailableTools(ctx.orgId, runId, [
      { integrationId: "@a/one", name: "send", reason: "not_listed" },
      { integrationId: "@b/two", name: "read", reason: "blocked_in_space" },
    ]);

    expect(await recorded()).toEqual([
      { integration_id: "@a/one", name: "send", reason: "not_listed" },
      { integration_id: "@b/two", name: "read", reason: "blocked_in_space" },
    ]);
  });

  it("caps each integration separately, the first listed winning, over every report", async () => {
    const many = (integrationId: string, from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => ({
        integrationId,
        name: `tool_${from + i}`,
        reason: "not_listed" as const,
      }));

    await recordRunUnavailableTools(ctx.orgId, runId, [
      ...many("@a/one", 0, 60),
      ...many("@b/two", 0, 3),
    ]);
    // A later report cannot raise an integration past the cap, nor repeat a recorded tool.
    await recordRunUnavailableTools(ctx.orgId, runId, [
      ...many("@a/one", 60, 70),
      ...many("@b/two", 0, 5),
    ]);

    const entries = await recorded();
    const of = (id: string) => entries.filter((e) => e.integration_id === id);
    expect(of("@a/one")).toHaveLength(50);
    expect(of("@a/one")[0]!.name).toBe("tool_0");
    expect(of("@a/one")[49]!.name).toBe("tool_49");
    expect(of("@b/two").map((e) => e.name)).toEqual([
      "tool_0",
      "tool_1",
      "tool_2",
      "tool_3",
      "tool_4",
    ]);
  });

  it("writes nothing for another organization's id", async () => {
    await recordRunUnavailableTools("org_someone_else", runId, [
      { integrationId: "@a/one", name: "send", reason: "not_listed" },
    ]);

    expect(await recorded()).toEqual([]);
  });
});
