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
import { computeRunCost, computeRunPricingStatus } from "../../../src/services/state/runs.ts";
import type { TokenPricingStatus } from "@appstrate/afps-runtime/runner";

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
        pricingStatus: "priced" as const,
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

    expect(await computeRunCost(run.id, ctx.orgId)).toBeCloseTo(0.02, 10);
  });

  it("returns 0 for a run with no ledger rows", async () => {
    const run = await seedTestRun();
    expect(await computeRunCost(run.id, ctx.orgId)).toBe(0);
  });
});

/**
 * `computeRunPricingStatus` — the companion read that qualifies the number
 * above. It must aggregate the WORST verdict over EXACTLY the rows
 * `computeRunCost` sums: a status computed over a different row set could mark
 * a total `priced` on the strength of a row that total does not contain.
 */
describe("computeRunPricingStatus — worst-of over the same rows as the cost", () => {
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

  async function proxyRow(runId: string, pricingStatus: TokenPricingStatus | null) {
    await recordLlmUsage({
      source: "proxy",
      orgId: ctx.orgId,
      runId,
      credentialSource: "system",
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.01,
      pricingStatus,
      requestId: `req_status_${crypto.randomUUID()}`,
    });
  }

  it("any unpriced row wins", async () => {
    const run = await seedTestRun();
    await proxyRow(run.id, "priced");
    await proxyRow(run.id, "partial");
    await proxyRow(run.id, "unpriced");
    expect(await computeRunPricingStatus(run.id, ctx.orgId)).toBe("unpriced");
  });

  it("partial wins over priced", async () => {
    const run = await seedTestRun();
    await proxyRow(run.id, "priced");
    await proxyRow(run.id, "partial");
    expect(await computeRunPricingStatus(run.id, ctx.orgId)).toBe("partial");
  });

  it("all priced → priced", async () => {
    const run = await seedTestRun();
    await proxyRow(run.id, "priced");
    await proxyRow(run.id, "priced");
    expect(await computeRunPricingStatus(run.id, ctx.orgId)).toBe("priced");
  });

  it("no rows, or rows carrying no verdict → null (never coerced to priced)", async () => {
    const empty = await seedTestRun();
    expect(await computeRunPricingStatus(empty.id, ctx.orgId)).toBeNull();

    const unstamped = await seedTestRun();
    await proxyRow(unstamped.id, null);
    expect(await computeRunPricingStatus(unstamped.id, ctx.orgId)).toBeNull();
  });

  it("ignores the excluded remote runner mirror — same filter as the cost", async () => {
    // The mirror duplicates spend already covered by the proxy rows, so it is
    // invisible to `computeRunCost`; its verdict must be invisible here too,
    // or a run would be flagged on a row nobody billed.
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

    expect(await computeRunPricingStatus(run.id, ctx.orgId)).toBe("priced");
    expect(await computeRunCost(run.id, ctx.orgId)).toBeCloseTo(0.01, 10);
  });

  it("is tenant-scoped like the cost: another org's id yields null", async () => {
    const run = await seedTestRun();
    await proxyRow(run.id, "unpriced");
    expect(
      await computeRunPricingStatus(run.id, "00000000-0000-4000-a000-000000000009"),
    ).toBeNull();
  });
});
