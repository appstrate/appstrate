// SPDX-License-Identifier: Apache-2.0

/**
 * Agent (package) deletion preserves observability — locks down the intent of
 * migration 0017 (`runs.package_id` is `ON DELETE SET NULL`). Deleting a package
 * orphans its runs (package_id = NULL, denormalized agent_scope/agent_name kept)
 * rather than deleting them, so their run_logs and llm_usage rows — still
 * attached to the surviving run — are untouched. Deletion succeeds with 204.
 *
 * (Distinct from run DELETION, which detaches llm_usage to run_id = NULL — see
 * `llm-usage-detach.test.ts`. Deleting the package does not delete the runs.)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { isEmbeddedDb, reservePgConnection } from "@appstrate/db/client";
import { createRun } from "../../../src/services/state/runs.ts";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedRunLog, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import { assertDbHas, assertDbMissing } from "../../helpers/assertions.ts";
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
      spaceId: ctx.defaultSpaceId,
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

    // llm_usage rows survive, still attached — the run is alive (package
    // delete only nulled runs.package_id), so nothing detaches them.
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
      spaceId: ctx.defaultSpaceId,
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

  it("refuses deleting an agent while a run of it runs in another space, but lets its author publish and restore", async () => {
    await seedAgent({
      id: "@delorg/elsewhere",
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      homeSpaceId: ctx.defaultSpaceId,
      draftManifest: {
        name: "@delorg/elsewhere",
        schema_version: "0.2",
        version: "0.2.0",
        type: "agent",
        display_name: "Elsewhere",
        description: "Agent with a run in another space",
      },
    });
    const other = await seedSpace({ orgId: ctx.orgId, name: "Ailleurs" });
    await seedSpacePackage(other.id, "@delorg/elsewhere");
    await seedRun({
      packageId: "@delorg/elsewhere",
      orgId: ctx.orgId,
      spaceId: other.id,
      status: "running",
    });

    const removed = await app.request("/api/packages/agents/@delorg/elsewhere", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(removed.status).toBe(409);
    const body = (await removed.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("agent_in_use");
    expect(body.detail).toContain("another space of the organization");
    await assertDbHas(packages, eq(packages.id, "@delorg/elsewhere"));

    // A published run froze its version, and a draft run already reads every draft save:
    // publishing and restoring wait for no run, in any space.
    const published = await app.request("/api/packages/agents/@delorg/elsewhere/versions", {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(published.status, await published.clone().text()).toBe(201);
    const versionUrl = "/api/packages/agents/@delorg/elsewhere/versions/0.2.0";
    const restore = () =>
      app.request(`${versionUrl}/restore`, { method: "POST", headers: authHeaders(ctx) });
    expect((await restore()).status).toBe(200);
    const removedVersion = await app.request(versionUrl, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(removedVersion.status).toBe(409);
    expect(await removedVersion.json()).toHaveProperty("code", "agent_in_use");
  });

  it.skipIf(isEmbeddedDb)(
    "waits for a concurrent run admission before deciding whether the agent may be deleted",
    async () => {
      const packageId = "@delorg/admitting";
      await seedAgent({ id: packageId, orgId: ctx.orgId, createdBy: ctx.user.id });
      const other = await seedSpace({ orgId: ctx.orgId, name: "Ailleurs" });
      await seedSpacePackage(other.id, packageId);
      const connection = (await reservePgConnection())!;
      let removing: Promise<Response> | undefined;
      try {
        await connection.sql`BEGIN`;
        // An admitted run still uncommitted: its FK holds KEY SHARE on the package.
        await connection.sql`INSERT INTO runs (id, package_id, org_id, space_id)
        VALUES ('run_admitting', ${packageId}, ${ctx.orgId}, ${other.id})`;
        removing = Promise.resolve(
          app.request(`/api/packages/agents/${packageId}`, {
            method: "DELETE",
            headers: authHeaders(ctx),
          }),
        );
        const deadline = Date.now() + 3000;
        while (true) {
          const rows = await connection.sql`SELECT 1 FROM pg_locks
          WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`;
          if (rows.length > 0) break;
          if (Date.now() >= deadline)
            throw new Error("Package deletion did not wait for admission");
          await Bun.sleep(10);
        }
        await connection.sql`COMMIT`;
        const response = await removing;
        expect(response.status).toBe(409);
        expect(await response.json()).toHaveProperty("code", "agent_in_use");
        await assertDbHas(packages, eq(packages.id, packageId));
      } finally {
        await connection.sql`ROLLBACK`;
        connection.release();
        await removing;
      }
    },
  );

  it("refuses admission when the agent or its pinned version disappeared after preflight", async () => {
    const packageId = "@delorg/gone";
    const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    const id = "run_package_disappeared";
    const launch = () =>
      createRun(scope, {
        id,
        packageId,
        versionRef: "1.0.0",
        actor: null,
        input: null,
        modelId: null,
        inferenceRoute: null,
      });
    await expect(launch()).rejects.toMatchObject({ status: 404 });
    await seedAgent({ id: packageId, orgId: ctx.orgId, createdBy: ctx.user.id });
    await expect(launch()).rejects.toMatchObject({ status: 404 });
    await assertDbMissing(runs, eq(runs.id, id));
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
      spaceId: ctx.defaultSpaceId,
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
    expect(row.agent_scope).toBe("@delorg");
    expect(row.agent_name).toBe("Ghost Agent");
    // packageEphemeral defaults to false on a deleted-package row — the
    // LEFT JOIN on `packages` produces no match, the mapper coalesces to
    // false. Inline detection still requires a non-null package_id.
    expect(row.package_ephemeral).toBe(false);
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
      spaceId: ctx.defaultSpaceId,
      status: "success",
      completedAt: new Date(),
    });
    const dropRun = await seedRun({
      packageId: "@delorg/drop",
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
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
