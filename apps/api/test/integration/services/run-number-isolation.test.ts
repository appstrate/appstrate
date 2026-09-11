// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for nextRunNumber isolation per space.
 *
 * Verifies that run numbering is independent per (packageId, orgId, spaceId).
 * Since nextRunNumber is private, we test through createRun and verify via DB.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedSpace } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/space-packages.ts";
import { createRun } from "../../../src/services/state/runs.ts";
import { initRunLimits } from "../../../src/services/run-limits.ts";
import { runs } from "@appstrate/db/schema";
import { eq, and } from "drizzle-orm";

describe("nextRunNumber isolation per space", () => {
  let ctx: TestContext;
  let spaceBId: string;
  const agentId = "@testorg/run-num-agent";

  beforeEach(async () => {
    await truncateAll();
    // `createRun`'s per-org concurrency reservation reads the limits registry
    // and lets an uninitialized read THROW — a fail-open catch there would
    // silently uncap the org. This file never boots the app, so it boots the
    // registry itself.
    initRunLimits();
    ctx = await createTestContext();
    const spaceB = await seedSpace({ orgId: ctx.orgId, name: "SpaceB" });
    spaceBId = spaceB.id;

    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, agentId);
    await installPackage({ orgId: ctx.orgId, spaceId: spaceBId }, agentId);
  });

  it("assigns run number 1 to the first run in each space independently", async () => {
    const actor = { type: "user" as const, id: ctx.user.id };

    await createRun(
      { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
      {
        id: "run_aaaabbbbcccc0001",
        packageId: agentId,
        actor,
        input: null,
      },
    );
    await createRun(
      { orgId: ctx.orgId, spaceId: spaceBId },
      {
        id: "run_aaaabbbbcccc0002",
        packageId: agentId,
        actor,
        input: null,
      },
    );

    const [runA] = await db
      .select({ runNumber: runs.runNumber })
      .from(runs)
      .where(and(eq(runs.id, "run_aaaabbbbcccc0001"), eq(runs.spaceId, ctx.defaultSpaceId)));

    const [runB] = await db
      .select({ runNumber: runs.runNumber })
      .from(runs)
      .where(and(eq(runs.id, "run_aaaabbbbcccc0002"), eq(runs.spaceId, spaceBId)));

    expect(runA!.runNumber).toBe(1);
    expect(runB!.runNumber).toBe(1);
  });

  it("increments run numbers independently per space", async () => {
    const actor = { type: "user" as const, id: ctx.user.id };

    const spaceAScope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    const spaceBScope = { orgId: ctx.orgId, spaceId: spaceBId };
    // 3 runs in SpaceA, 2 runs in SpaceB
    await createRun(spaceAScope, {
      id: "run_aaaa000000000001",
      packageId: agentId,
      actor,
      input: null,
    });
    await createRun(spaceAScope, {
      id: "run_aaaa000000000002",
      packageId: agentId,
      actor,
      input: null,
    });
    await createRun(spaceBScope, {
      id: "run_bbbb000000000001",
      packageId: agentId,
      actor,
      input: null,
    });
    await createRun(spaceAScope, {
      id: "run_aaaa000000000003",
      packageId: agentId,
      actor,
      input: null,
    });
    await createRun(spaceBScope, {
      id: "run_bbbb000000000002",
      packageId: agentId,
      actor,
      input: null,
    });

    const spaceARuns = await db
      .select({ id: runs.id, runNumber: runs.runNumber })
      .from(runs)
      .where(and(eq(runs.packageId, agentId), eq(runs.spaceId, ctx.defaultSpaceId)));

    const spaceBRuns = await db
      .select({ id: runs.id, runNumber: runs.runNumber })
      .from(runs)
      .where(and(eq(runs.packageId, agentId), eq(runs.spaceId, spaceBId)));

    expect(spaceARuns).toHaveLength(3);
    expect(spaceARuns.map((r) => r.runNumber).sort()).toEqual([1, 2, 3]);

    expect(spaceBRuns).toHaveLength(2);
    expect(spaceBRuns.map((r) => r.runNumber).sort()).toEqual([1, 2]);
  });
});
