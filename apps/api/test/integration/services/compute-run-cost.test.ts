// SPDX-License-Identifier: Apache-2.0

/**
 * `computeRunCost` — the single read path that sums the `llm_usage` ledger into
 * `runs.cost` (`services/state/runs.ts`). Locks down the remote-run mirror
 * exclusion: a remote-origin run whose inference flows through the system
 * llm-proxy gets BOTH per-call proxy rows AND the runner's cumulative
 * side-channel mirror row (`credential_source IS NULL`) covering the SAME spend.
 * Summing all rows double-counts (display only — cloud never debits the NULL
 * runner row), so the mirror is dropped when proxy rows exist. A platform run's
 * runner row carries a non-NULL `credential_source` and stays authoritative; a
 * remote run with ONLY a runner row keeps it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { recordLlmUsage } from "../../../src/services/llm-usage-ledger.ts";
import { computeRunCost } from "../../../src/services/state/runs.ts";

describe("computeRunCost — remote-run mirror exclusion", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "runcost" });
    await seedAgent({ id: "@runcost/agent", orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  async function seedTestRun() {
    return seedRun({
      packageId: "@runcost/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
    });
  }

  it("excludes the NULL-credential runner mirror when the run also has proxy rows", async () => {
    // Remote run: 2 system-proxy per-call rows ($0.01 each) + the runner's
    // cumulative mirror ($0.02, credential_source NULL) covering the same spend.
    const run = await seedTestRun();
    await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      runId: run.id,
      credentialSource: "system",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.01,
      requestId: "req_runcost_1",
    });
    await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      runId: run.id,
      credentialSource: "system",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.01,
      requestId: "req_runcost_2",
    });
    await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId: run.id,
        credentialSource: null, // remote run resolves no platform model
        inputTokens: 20,
        outputTokens: 20,
        costUsd: 0.02,
      },
      { onConflict: "runner-monotonic" },
    );

    // Only the two proxy rows count — the mirror is dropped (would be $0.04).
    expect(await computeRunCost(run.id, ctx.orgId)).toBeCloseTo(0.02, 10);
  });

  it("keeps a platform runner row (non-NULL credential_source) even alongside proxy rows", async () => {
    // A platform run's runner row is stamped from runs.model_source, so it is
    // authoritative and never treated as a remote mirror.
    const run = await seedTestRun();
    await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      runId: run.id,
      credentialSource: "system",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.01,
      requestId: "req_runcost_platform",
    });
    await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId: run.id,
        credentialSource: "system", // platform run
        inputTokens: 20,
        outputTokens: 20,
        costUsd: 0.03,
        durationMs: 1,
      },
      { onConflict: "runner-monotonic" },
    );

    expect(await computeRunCost(run.id, ctx.orgId)).toBeCloseTo(0.04, 10);
  });

  it("keeps a lone runner mirror when the run has NO proxy rows (remote, own credentials)", async () => {
    // A remote run that used its own credentials emits no proxy rows — its
    // NULL-credential runner row is the ONLY cost record and must be summed.
    const run = await seedTestRun();
    await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId: run.id,
        credentialSource: null,
        inputTokens: 20,
        outputTokens: 20,
        costUsd: 0.05,
      },
      { onConflict: "runner-monotonic" },
    );

    expect(await computeRunCost(run.id, ctx.orgId)).toBeCloseTo(0.05, 10);
  });

  it("sums proxy-only rows unchanged", async () => {
    const run = await seedTestRun();
    await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      runId: run.id,
      credentialSource: "org",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.012,
      requestId: "req_runcost_p1",
    });
    await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      runId: run.id,
      credentialSource: "org",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.008,
      requestId: "req_runcost_p2",
    });

    expect(await computeRunCost(run.id, ctx.orgId)).toBeCloseTo(0.02, 10);
  });

  it("returns 0 for a run with no ledger rows", async () => {
    const run = await seedTestRun();
    expect(await computeRunCost(run.id, ctx.orgId)).toBe(0);
  });
});
