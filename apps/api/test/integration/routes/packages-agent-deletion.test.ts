// SPDX-License-Identifier: Apache-2.0

/**
 * Agent deletion preserves observability — the test that locks down the
 * intent of migration 0017 (`runs.package_id` switched from CASCADE to SET
 * NULL) and migration 0016 (`llm_usage.run_id` switched from SET NULL to
 * CASCADE).
 *
 * Before 0016/0017, deleting an agent that had any terminated run raised a
 * generic 500 (CHECK violation on `llm_usage_runner_has_run_id` triggered
 * by the SET NULL cascade). After: deletion succeeds with 204, runs survive
 * as orphans (package_id = NULL, denormalized agent_scope/agent_name kept),
 * llm_usage rows survive (still attached to the run), run_logs survive.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedRunLog } from "../../helpers/seed.ts";
import { assertDbMissing } from "../../helpers/assertions.ts";
import { packages, runs, runLogs, llmUsage } from "@appstrate/db/schema";

const app = getTestApp();

describe("DELETE /api/packages/agents/:scope/:name — observability preservation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "delorg" });
  });

  it("returns 204 and orphans the run when agent had terminated runs with llm_usage", async () => {
    // Seed an agent with one terminated run carrying both runner-source
    // llm_usage (the trigger of the original 500) and run_logs.
    await seedAgent({
      id: "@delorg/zombie",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });

    const run = await seedRun({
      packageId: "@delorg/zombie",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
      agentScope: "@delorg",
      agentName: "Zombie Agent",
      cost: 0.0042,
      completedAt: new Date(),
    });

    await seedRunLog({
      runId: run.id,
      orgId: ctx.orgId,
      message: "log line for posterity",
    });

    await db.insert(llmUsage).values({
      source: "runner",
      orgId: ctx.orgId,
      userId: ctx.user.id,
      runId: run.id,
      inputTokens: 100,
      outputTokens: 200,
      costUsd: 0.0042,
    });

    const res = await app.request("/api/packages/agents/@delorg/zombie", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });

    expect(res.status).toBe(204);

    // Agent is gone.
    await assertDbMissing(packages, eq(packages.id, "@delorg/zombie"));

    // Run survives, package_id NULLed, snapshots intact.
    const [orphan] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(orphan).toBeDefined();
    expect(orphan!.packageId).toBeNull();
    expect(orphan!.agentScope).toBe("@delorg");
    expect(orphan!.agentName).toBe("Zombie Agent");
    expect(orphan!.cost).toBe(0.0042);
    expect(orphan!.status).toBe("success");

    // run_logs survive (FK to runs.id with CASCADE — but the run itself
    // is alive, so cascade does not fire).
    const logs = await db.select().from(runLogs).where(eq(runLogs.runId, run.id));
    expect(logs.length).toBe(1);
    expect(logs[0]!.message).toBe("log line for posterity");

    // llm_usage rows survive — the run is alive, the runner-source
    // CHECK invariant (run_id NOT NULL) holds.
    const usage = await db.select().from(llmUsage).where(eq(llmUsage.runId, run.id));
    expect(usage.length).toBe(1);
    expect(usage[0]!.source).toBe("runner");
    expect(usage[0]!.runId).toBe(run.id);
  });

  it("returns 409 agent_in_use when a pending or running run still owns the package", async () => {
    await seedAgent({
      id: "@delorg/busy",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });

    await seedRun({
      packageId: "@delorg/busy",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
    });

    const res = await app.request("/api/packages/agents/@delorg/busy", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("agent_in_use");
  });

  it("orphaned runs surface in GET /api/runs with the denormalized name", async () => {
    await seedAgent({
      id: "@delorg/ghost",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });

    await seedRun({
      packageId: "@delorg/ghost",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
      agentScope: "@delorg",
      agentName: "Ghost Agent",
      completedAt: new Date(),
    });

    const del = await app.request("/api/packages/agents/@delorg/ghost", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(204);

    const res = await app.request("/api/runs?kind=package", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data.length).toBe(1);
    const row = body.data[0]!;
    expect(row.packageId).toBeNull();
    expect(row.agentScope).toBe("@delorg");
    expect(row.agentName).toBe("Ghost Agent");
    // packageEphemeral defaults to false on a deleted-package row — the
    // LEFT JOIN on `packages` produces no match, the mapper coalesces to
    // false. Inline detection still requires a non-null package_id.
    expect(row.packageEphemeral).toBe(false);
  });

  it("deleting one agent does not affect another agent's runs", async () => {
    await seedAgent({
      id: "@delorg/keep",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
    await seedAgent({
      id: "@delorg/drop",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });

    const keepRun = await seedRun({
      packageId: "@delorg/keep",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
      completedAt: new Date(),
    });
    const dropRun = await seedRun({
      packageId: "@delorg/drop",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
      completedAt: new Date(),
    });

    const res = await app.request("/api/packages/agents/@delorg/drop", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(204);

    const [keep] = await db.select().from(runs).where(eq(runs.id, keepRun.id));
    expect(keep!.packageId).toBe("@delorg/keep");

    const [drop] = await db.select().from(runs).where(eq(runs.id, dropRun.id));
    expect(drop!.packageId).toBeNull();
  });
});
