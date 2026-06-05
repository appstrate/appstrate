// SPDX-License-Identifier: Apache-2.0

/**
 * `listLlmUsageForRun` — the platform accessor (`PlatformServices.runs.listLlmUsage`)
 * a metering module / external usage store uses to read the canonical `llm_usage` ledger
 * WITHOUT a cross-module SQL join. Locks down: source filtering, org scoping,
 * and the empty-sources short-circuit.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { listLlmUsageForRun } from "../../../src/services/state/runs.ts";
import { llmUsage } from "@appstrate/db/schema";

describe("listLlmUsageForRun", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "meterorg" });
    await seedAgent({ id: "@meterorg/agent", orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  it("returns usage rows filtered by source, scoped to the org", async () => {
    const run = await seedRun({
      packageId: "@meterorg/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
    });
    await db.insert(llmUsage).values([
      { source: "runner", orgId: ctx.orgId, runId: run.id, costUsd: 0.01 },
      { source: "proxy", orgId: ctx.orgId, runId: run.id, costUsd: 0.02, requestId: "req_meter_1" },
    ]);

    const both = await listLlmUsageForRun({
      runId: run.id,
      orgId: ctx.orgId,
      sources: ["runner", "proxy"],
    });
    expect(both).toHaveLength(2);
    expect(both.every((r) => typeof r.id === "number")).toBe(true);
    expect(both.reduce((sum, r) => sum + r.costUsd, 0)).toBeCloseTo(0.03, 5);
    expect(both.map((r) => r.source).sort()).toEqual(["proxy", "runner"]);

    // Source filter excludes the proxy row when only "runner" is requested.
    const runnerOnly = await listLlmUsageForRun({
      runId: run.id,
      orgId: ctx.orgId,
      sources: ["runner"],
    });
    expect(runnerOnly).toHaveLength(1);
    expect(runnerOnly[0]!.source).toBe("runner");
  });

  it("short-circuits to [] on empty sources", async () => {
    const run = await seedRun({
      packageId: "@meterorg/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
    });
    await db.insert(llmUsage).values({
      source: "runner",
      orgId: ctx.orgId,
      runId: run.id,
      costUsd: 0.05,
    });

    expect(await listLlmUsageForRun({ runId: run.id, orgId: ctx.orgId, sources: [] })).toHaveLength(
      0,
    );
  });

  it("does not leak rows across orgs", async () => {
    const run = await seedRun({
      packageId: "@meterorg/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
    });
    await db.insert(llmUsage).values({
      source: "runner",
      orgId: ctx.orgId,
      runId: run.id,
      costUsd: 0.07,
    });

    const other = await createTestContext({ orgSlug: "otherorg" });
    const rows = await listLlmUsageForRun({
      runId: run.id,
      orgId: other.orgId,
      sources: ["runner", "proxy"],
    });
    expect(rows).toHaveLength(0);
  });
});
