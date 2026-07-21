// SPDX-License-Identifier: Apache-2.0

/**
 * `listLlmUsage` + `getMaxLlmUsageId` — the platform cursor read
 * (`PlatformServices.usage.list` / `.maxId`) a metering module uses to sweep the
 * canonical `llm_usage` ledger by serial `id` WITHOUT a cross-module SQL join.
 * Locks down: id-ASC ordering, the `afterId` cursor, context derivation,
 * `credentialSource` filtering, limit clamping, the projection (never
 * `real_model`/`api`), and the `settled` flag that governs cursor correctness.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { listLlmUsage, getMaxLlmUsageId } from "../../../src/services/state/runs.ts";
import { llmUsage, chatSessions } from "@appstrate/db/schema";

describe("listLlmUsage / getMaxLlmUsageId", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "meterorg" });
    await seedAgent({ id: "@meterorg/agent", orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  it("returns rows ordered by id ASC, deriving context type/id per attribution", async () => {
    const run = await seedRun({
      packageId: "@meterorg/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
    });
    await db.insert(chatSessions).values({
      id: "chs_meter_1",
      orgId: ctx.orgId,
      userId: ctx.user.id,
    });
    await db.insert(llmUsage).values([
      { source: "runner", orgId: ctx.orgId, runId: run.id, costUsd: 0.01 },
      {
        source: "proxy",
        orgId: ctx.orgId,
        chatSessionId: "chs_meter_1",
        costUsd: 0.02,
        requestId: "req_meter_chat",
      },
      // Un-attributed proxy row (no run, no chat) → context null.
      { source: "proxy", orgId: ctx.orgId, costUsd: 0.03, requestId: "req_meter_bare" },
    ]);

    const rows = await listLlmUsage({});
    expect(rows).toHaveLength(3);
    // id ASC
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort((a, b) => a - b));

    const runRow = rows.find((r) => r.source === "runner")!;
    expect(runRow.contextType).toBe("run");
    expect(runRow.contextId).toBe(run.id);

    const chatRow = rows.find((r) => r.contextType === "chat")!;
    expect(chatRow.contextId).toBe("chs_meter_1");

    const bareRow = rows.find((r) => r.contextId === null)!;
    expect(bareRow.contextType).toBeNull();

    // The projection NEVER carries real_model / api (server-side only columns).
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "contextId",
        "contextType",
        "costUsd",
        "credentialSource",
        "id",
        "orgId",
        "settled",
        "source",
      ].sort(),
    );
  });

  it("advances past a cursor (afterId is exclusive) and caps by limit", async () => {
    await db.insert(llmUsage).values(
      Array.from({ length: 5 }, (_, i) => ({
        source: "proxy" as const,
        orgId: ctx.orgId,
        costUsd: 0.01,
        requestId: `req_cursor_${i}`,
      })),
    );
    const all = await listLlmUsage({});
    expect(all).toHaveLength(5);

    const afterFirst = await listLlmUsage({ afterId: all[0]!.id });
    expect(afterFirst).toHaveLength(4);
    expect(afterFirst.every((r) => r.id > all[0]!.id)).toBe(true);

    const firstTwo = await listLlmUsage({ limit: 2 });
    expect(firstTwo).toHaveLength(2);
    expect(firstTwo.map((r) => r.id)).toEqual([all[0]!.id, all[1]!.id]);
  });

  it("filters by credentialSource when provided", async () => {
    await db.insert(llmUsage).values([
      {
        source: "proxy",
        orgId: ctx.orgId,
        costUsd: 0.01,
        credentialSource: "system",
        requestId: "req_cs_sys",
      },
      {
        source: "proxy",
        orgId: ctx.orgId,
        costUsd: 0.01,
        credentialSource: "org",
        requestId: "req_cs_org",
      },
    ]);
    const systemOnly = await listLlmUsage({ credentialSource: "system" });
    expect(systemOnly).toHaveLength(1);
    expect(systemOnly[0]!.credentialSource).toBe("system");
  });

  it("marks proxy/chat rows settled immediately; runner rows settle only at terminal run status", async () => {
    const activeRun = await seedRun({
      packageId: "@meterorg/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
    });
    const doneRun = await seedRun({
      packageId: "@meterorg/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
    });
    await db.insert(llmUsage).values([
      // Runner row on an in-flight run → cost still growing → unsettled.
      { source: "runner", orgId: ctx.orgId, runId: activeRun.id, costUsd: 0.5 },
      // Runner row on a terminal run → settled.
      { source: "runner", orgId: ctx.orgId, runId: doneRun.id, costUsd: 0.5 },
      // Proxy row (immutable at insert) → settled even attributed to the live run.
      {
        source: "proxy",
        orgId: ctx.orgId,
        runId: activeRun.id,
        costUsd: 0.1,
        requestId: "req_settled_proxy",
      },
    ]);

    const rows = await listLlmUsage({});
    const bySource = (s: string, runId: string) =>
      rows.find((r) => r.source === s && r.contextId === runId)!;

    expect(bySource("runner", activeRun.id).settled).toBe(false);
    expect(bySource("runner", doneRun.id).settled).toBe(true);
    expect(bySource("proxy", activeRun.id).settled).toBe(true);
  });

  it("getMaxLlmUsageId returns 0 when empty and the max id otherwise", async () => {
    expect(await getMaxLlmUsageId()).toBe(0);
    await db.insert(llmUsage).values({
      source: "proxy",
      orgId: ctx.orgId,
      costUsd: 0.01,
      requestId: "req_max_1",
    });
    const rows = await listLlmUsage({});
    expect(await getMaxLlmUsageId()).toBe(rows.at(-1)!.id);
  });
});
