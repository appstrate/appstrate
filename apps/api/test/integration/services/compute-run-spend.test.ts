// SPDX-License-Identifier: Apache-2.0

/**
 * `computeRunSpend` — the single read path that rolls the `llm_usage` ledger up
 * into `runs.cost` + `runs.cost_pricing_status` (`services/state/runs.ts`).
 *
 * Two properties are locked down here.
 *
 * 1. The remote-run mirror exclusion: a remote-origin run whose inference flows
 *    through the system llm-proxy gets BOTH per-call proxy rows AND the
 *    runner's cumulative side-channel mirror row (`credential_source IS NULL`)
 *    covering the SAME spend. Summing all rows double-counts (display only —
 *    cloud never debits the NULL runner row), so the mirror is dropped when
 *    proxy rows exist. A platform run's runner row carries a non-NULL
 *    `credential_source` and stays authoritative; a remote run with ONLY a
 *    runner row keeps it.
 *
 * 2. Cost and provenance come from ONE aggregate over ONE row set. The status
 *    is the WORST verdict among the rows the cost actually contains — a status
 *    computed over a different row set could mark a total `priced` on the
 *    strength of a row that total does not include.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { recordLlmUsage } from "../../../src/services/llm-usage-ledger.ts";
import { computeRunSpend } from "../../../src/services/state/runs.ts";
import type { TokenPricingStatus } from "@appstrate/afps-runtime/runner";

describe("computeRunSpend — remote-run mirror exclusion", () => {
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
      pricingStatus: "priced" as const,
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
      pricingStatus: "priced" as const,
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
        pricingStatus: "priced" as const,
      },
      { onConflict: "runner-monotonic" },
    );

    // Only the two proxy rows count — the mirror is dropped (would be $0.04).
    expect((await computeRunSpend(run.id, ctx.orgId)).costUsd).toBeCloseTo(0.02, 10);
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
      pricingStatus: "priced" as const,
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
        pricingStatus: "priced" as const,
        durationMs: 1,
      },
      { onConflict: "runner-monotonic" },
    );

    expect((await computeRunSpend(run.id, ctx.orgId)).costUsd).toBeCloseTo(0.04, 10);
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
        pricingStatus: "priced" as const,
      },
      { onConflict: "runner-monotonic" },
    );

    expect((await computeRunSpend(run.id, ctx.orgId)).costUsd).toBeCloseTo(0.05, 10);
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
      pricingStatus: "priced" as const,
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
      pricingStatus: "priced" as const,
      requestId: "req_runcost_p2",
    });

    expect((await computeRunSpend(run.id, ctx.orgId)).costUsd).toBeCloseTo(0.02, 10);
  });

  it("returns 0 for a run with no ledger rows", async () => {
    const run = await seedTestRun();
    expect((await computeRunSpend(run.id, ctx.orgId)).costUsd).toBe(0);
  });
});

/**
 * The provenance half — the WORST verdict over EXACTLY the rows the cost sums.
 */
describe("computeRunSpend — worst-of provenance over the same rows as the cost", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "runstatus" });
    await seedAgent({ id: "@runstatus/agent", orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  async function seedTestRun() {
    return seedRun({
      packageId: "@runstatus/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "success",
    });
  }

  async function proxyRow(runId: string, pricingStatus: TokenPricingStatus | null, costUsd = 0.01) {
    await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      runId,
      credentialSource: "system",
      inputTokens: 10,
      outputTokens: 10,
      costUsd,
      pricingStatus,
      requestId: `req_status_${crypto.randomUUID()}`,
    });
  }

  it("any unpriced row wins", async () => {
    const run = await seedTestRun();
    await proxyRow(run.id, "priced");
    await proxyRow(run.id, "partial");
    await proxyRow(run.id, "unpriced");
    expect((await computeRunSpend(run.id, ctx.orgId)).pricingStatus).toBe("unpriced");
  });

  it("partial wins over priced", async () => {
    const run = await seedTestRun();
    await proxyRow(run.id, "priced");
    await proxyRow(run.id, "partial");
    expect((await computeRunSpend(run.id, ctx.orgId)).pricingStatus).toBe("partial");
  });

  it("all priced → priced", async () => {
    const run = await seedTestRun();
    await proxyRow(run.id, "priced");
    await proxyRow(run.id, "priced");
    expect((await computeRunSpend(run.id, ctx.orgId)).pricingStatus).toBe("priced");
  });

  it("no rows, or rows carrying no verdict → null (never coerced to priced)", async () => {
    const empty = await seedTestRun();
    expect((await computeRunSpend(empty.id, ctx.orgId)).pricingStatus).toBeNull();

    const unstamped = await seedTestRun();
    await proxyRow(unstamped.id, null);
    expect((await computeRunSpend(unstamped.id, ctx.orgId)).pricingStatus).toBeNull();
  });

  it("reports cost and provenance from ONE read over a mixed-row run", async () => {
    // The whole point of the merge: a run mixing a priced call, an unpriced
    // one, and the runner's own row must report the summed total AND the worst
    // verdict — from the same rows, in one call.
    const run = await seedTestRun();
    await proxyRow(run.id, "priced", 0.02);
    await proxyRow(run.id, "unpriced", 0);
    await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId: run.id,
        credentialSource: "system", // platform run → NOT a mirror, counted
        inputTokens: 20,
        outputTokens: 20,
        costUsd: 0.03,
        pricingStatus: "partial",
      },
      { onConflict: "runner-monotonic" },
    );

    const spend = await computeRunSpend(run.id, ctx.orgId);
    expect(spend.costUsd).toBeCloseTo(0.05, 10);
    expect(spend.pricingStatus).toBe("unpriced");
  });

  it("ignores the excluded remote runner mirror — cost and status share the filter", async () => {
    // The mirror duplicates spend already covered by the proxy rows, so it is
    // invisible to the sum; its verdict must be invisible too, or a run would
    // be flagged on a row nobody billed.
    const run = await seedTestRun();
    await proxyRow(run.id, "priced");
    await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId: run.id,
        credentialSource: null, // remote mirror
        inputTokens: 20,
        outputTokens: 20,
        costUsd: 0.02,
        pricingStatus: "unpriced",
      },
      { onConflict: "runner-monotonic" },
    );

    const spend = await computeRunSpend(run.id, ctx.orgId);
    expect(spend.pricingStatus).toBe("priced");
    expect(spend.costUsd).toBeCloseTo(0.01, 10);
  });

  it("is tenant-scoped on both halves: another org's id yields 0 / null", async () => {
    const run = await seedTestRun();
    await proxyRow(run.id, "unpriced");
    const spend = await computeRunSpend(run.id, "00000000-0000-4000-a000-000000000009");
    expect(spend.costUsd).toBe(0);
    expect(spend.pricingStatus).toBeNull();
  });
});
