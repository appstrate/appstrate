// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for nextRunNumber isolation per application.
 *
 * Verifies that run numbering is independent per (packageId, orgId, applicationId).
 * Since nextRunNumber is private, we test through createRun and verify via DB.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedApplication } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { createRun } from "../../../src/services/state/runs.ts";
import { runs } from "@appstrate/db/schema";
import { eq, and } from "drizzle-orm";

describe("nextRunNumber isolation per application", () => {
  let ctx: TestContext;
  let appBId: string;
  const agentId = "@testorg/run-num-agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    const appB = await seedApplication({ orgId: ctx.orgId, name: "AppB" });
    appBId = appB.id;

    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, agentId);
    await installPackage({ orgId: ctx.orgId, applicationId: appBId }, agentId);
  });

  it("assigns run number 1 to the first run in each application independently", async () => {
    const actor = { type: "member" as const, id: ctx.user.id };

    await createRun(
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      {
        id: "exec_aaaabbbbcccc0001",
        packageId: agentId,
        actor,
        input: null,
      },
    );
    await createRun(
      { orgId: ctx.orgId, applicationId: appBId },
      {
        id: "exec_aaaabbbbcccc0002",
        packageId: agentId,
        actor,
        input: null,
      },
    );

    const [runA] = await db
      .select({ runNumber: runs.runNumber })
      .from(runs)
      .where(and(eq(runs.id, "exec_aaaabbbbcccc0001"), eq(runs.applicationId, ctx.defaultAppId)));

    const [runB] = await db
      .select({ runNumber: runs.runNumber })
      .from(runs)
      .where(and(eq(runs.id, "exec_aaaabbbbcccc0002"), eq(runs.applicationId, appBId)));

    expect(runA!.runNumber).toBe(1);
    expect(runB!.runNumber).toBe(1);
  });

  it("increments run numbers independently per application", async () => {
    const actor = { type: "member" as const, id: ctx.user.id };

    const appAScope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    const appBScope = { orgId: ctx.orgId, applicationId: appBId };
    // 3 runs in AppA, 2 runs in AppB
    await createRun(appAScope, {
      id: "exec_aaaa000000000001",
      packageId: agentId,
      actor,
      input: null,
    });
    await createRun(appAScope, {
      id: "exec_aaaa000000000002",
      packageId: agentId,
      actor,
      input: null,
    });
    await createRun(appBScope, {
      id: "exec_bbbb000000000001",
      packageId: agentId,
      actor,
      input: null,
    });
    await createRun(appAScope, {
      id: "exec_aaaa000000000003",
      packageId: agentId,
      actor,
      input: null,
    });
    await createRun(appBScope, {
      id: "exec_bbbb000000000002",
      packageId: agentId,
      actor,
      input: null,
    });

    const appARuns = await db
      .select({ id: runs.id, runNumber: runs.runNumber })
      .from(runs)
      .where(and(eq(runs.packageId, agentId), eq(runs.applicationId, ctx.defaultAppId)));

    const appBRuns = await db
      .select({ id: runs.id, runNumber: runs.runNumber })
      .from(runs)
      .where(and(eq(runs.packageId, agentId), eq(runs.applicationId, appBId)));

    expect(appARuns).toHaveLength(3);
    expect(appARuns.map((r) => r.runNumber).sort()).toEqual([1, 2, 3]);

    expect(appBRuns).toHaveLength(2);
    expect(appBRuns.map((r) => r.runNumber).sort()).toEqual([1, 2]);
  });
});
