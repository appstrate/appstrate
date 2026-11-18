// SPDX-License-Identifier: Apache-2.0

/**
 * Admission of a platform run against its plan's compute limits, through the real
 * `beforeUsage` hook: the Free plan's 1 000 monthly minutes and its three concurrent runs.
 * A new run is refused at zero minutes remaining (also when it brings its own LLM key); a run
 * already started, a chat turn and a remote run are never refused for minutes; the month
 * boundary gives the quota back.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { truncateBillingTables } from "../../helpers/db.ts";
import { seedBillingAccount, seedComputeUsage } from "../../helpers/seed.ts";
import { useBillingTestSeams } from "../../helpers/setup.ts";
import { checkComputeAdmission } from "../../../src/compute/admission.ts";
import { periodStartOf } from "../../../src/compute/period.ts";
import { FREE_INCLUDED_COMPUTE_MINUTES, FREE_MAX_CONCURRENT_RUNS } from "../../../src/config.ts";
import billingModule from "../../../src/index.ts";

useBillingTestSeams();

const orgId = "00000000-0000-4000-a000-000000000b01";
const NOW = new Date();
const THIS_MONTH = periodStartOf(NOW);
const QUOTA_SECONDS = FREE_INCLUDED_COMPUTE_MINUTES * 60;

type RunParams = {
  orgId: string;
  context: "run";
  packageId: string;
  runningCount: number;
  credentialSource: "system" | "org" | "user" | null;
  executionPlane: "platform" | "remote";
  timeoutSeconds: number | null;
};

function runParams(overrides: Partial<RunParams> = {}): RunParams {
  return {
    orgId,
    context: "run",
    packageId: "@x/agent",
    runningCount: 1,
    credentialSource: "org",
    executionPlane: "platform",
    timeoutSeconds: 600,
    ...overrides,
  };
}

function beforeUsage(
  ...args: Parameters<NonNullable<NonNullable<typeof billingModule.hooks>["beforeUsage"]>>
) {
  return billingModule.hooks!.beforeUsage!(...args);
}

describe("compute minutes admission (Free plan)", () => {
  beforeEach(async () => {
    await truncateBillingTables();
    await seedBillingAccount({ orgId, planId: "free" });
  });

  it("admits a run while minutes remain", async () => {
    await seedComputeUsage({ orgId, periodStart: THIS_MONTH, secondsUsed: QUOTA_SECONDS - 1 });
    expect(await beforeUsage(runParams())).toBeNull();
  });

  it("refuses a new run at zero minutes remaining, with a 402 that points at the Team plan", async () => {
    await seedComputeUsage({ orgId, periodStart: THIS_MONTH, secondsUsed: QUOTA_SECONDS });

    const refusal = await beforeUsage(runParams());

    expect(refusal).not.toBeNull();
    expect(refusal!.status).toBe(402);
    expect(refusal!.code).toBe("compute_quota_exceeded");
    expect(refusal!.message).toContain("1,000 compute minutes");
    expect(refusal!.message).toContain("Team plan");
    expect(refusal!.message).toContain("not interrupted");
  });

  it("refuses a run that brings its own LLM key as well as one on a platform credential", async () => {
    await seedComputeUsage({ orgId, periodStart: THIS_MONTH, secondsUsed: QUOTA_SECONDS + 500 });

    const byok = await beforeUsage(runParams({ credentialSource: "org" }));
    const system = await beforeUsage(runParams({ credentialSource: "system" }));
    const unknown = await beforeUsage(runParams({ credentialSource: null }));

    expect(byok?.code).toBe("compute_quota_exceeded");
    expect(system?.code).toBe("compute_quota_exceeded");
    expect(unknown?.code).toBe("compute_quota_exceeded");
  });

  it("names the renewal date: the first of next month", async () => {
    await seedComputeUsage({ orgId, periodStart: "2026-11-01", secondsUsed: QUOTA_SECONDS });
    const refusal = await checkComputeAdmission(runParams(), new Date("2026-11-17T12:00:00Z"));
    expect(refusal!.message).toContain("2026-12-01");
  });

  it("gives the quota back when the month changes", async () => {
    await seedComputeUsage({ orgId, periodStart: "2026-11-01", secondsUsed: QUOTA_SECONDS });

    const inNovember = await checkComputeAdmission(runParams(), new Date("2026-11-30T23:59:59Z"));
    const inDecember = await checkComputeAdmission(runParams(), new Date("2026-12-01T00:00:00Z"));

    expect(inNovember?.code).toBe("compute_quota_exceeded");
    expect(inDecember).toBeNull();
  });

  it("never refuses for minutes what owns no platform compute", async () => {
    await seedComputeUsage({ orgId, periodStart: THIS_MONTH, secondsUsed: QUOTA_SECONDS });

    // A run already running asking the system proxy for inference (`timeoutSeconds: null`).
    expect(
      await beforeUsage(runParams({ timeoutSeconds: null, credentialSource: "org" })),
    ).toBeNull();
    // A remote run: the caller's own host.
    expect(
      await beforeUsage(runParams({ executionPlane: "remote", credentialSource: "org" })),
    ).toBeNull();
    // A chat turn is not metered in minutes.
    expect(
      await beforeUsage({
        orgId,
        context: "chat",
        sessionId: "chs_1",
        credentialSource: "org",
        executionPlane: "platform",
      }),
    ).toBeNull();
  });

  it("still applies the credit quota to a run that has minutes left", async () => {
    await seedBillingAccount({ orgId: "00000000-0000-4000-a000-000000000b02", creditQuota: 0 });
    const refusal = await beforeUsage(
      runParams({ orgId: "00000000-0000-4000-a000-000000000b02", credentialSource: "system" }),
    );
    expect(refusal?.code).toBe("quota_exceeded");
  });

  it("does not gate an org with no billing account", async () => {
    await truncateBillingTables();
    expect(await beforeUsage(runParams())).toBeNull();
  });

  it("does not gate a plan that states no compute quota yet", async () => {
    await truncateBillingTables();
    await seedBillingAccount({ orgId, planId: "starter" });
    await seedComputeUsage({ orgId, periodStart: THIS_MONTH, secondsUsed: QUOTA_SECONDS * 100 });
    expect(await beforeUsage(runParams({ runningCount: 40 }))).toBeNull();
  });

  it("fails CLOSED when the billing database cannot answer", async () => {
    // A value the `org_id` uuid column cannot parse: a real database error under the read.
    const refusal = await beforeUsage(runParams({ orgId: "not-a-uuid" }));
    expect(refusal).toEqual({
      code: "unexpected",
      message: "Billing is temporarily unavailable.",
      status: 500,
    });
  });
});

describe("concurrency per plan", () => {
  beforeEach(async () => {
    await truncateBillingTables();
    await seedBillingAccount({ orgId, planId: "free" });
  });

  it("admits up to the Free plan's three concurrent runs", async () => {
    // `runningCount` already includes the run being admitted.
    expect(await beforeUsage(runParams({ runningCount: FREE_MAX_CONCURRENT_RUNS }))).toBeNull();
  });

  it("refuses the fourth concurrent run with a 429", async () => {
    const refusal = await beforeUsage(runParams({ runningCount: FREE_MAX_CONCURRENT_RUNS + 1 }));

    expect(refusal).not.toBeNull();
    expect(refusal!.status).toBe(429);
    expect(refusal!.code).toBe("org_run_concurrency_exceeded");
    expect(refusal!.message).toContain("3 concurrent runs");
  });

  it("checks concurrency before minutes", async () => {
    await seedComputeUsage({ orgId, periodStart: THIS_MONTH, secondsUsed: QUOTA_SECONDS });
    const refusal = await beforeUsage(runParams({ runningCount: 4 }));
    expect(refusal?.code).toBe("org_run_concurrency_exceeded");
  });

  it("leaves a remote run and the system-proxy seam out of the concurrency cap", async () => {
    expect(await beforeUsage(runParams({ runningCount: 9, executionPlane: "remote" }))).toBeNull();
    expect(await beforeUsage(runParams({ runningCount: 9, timeoutSeconds: null }))).toBeNull();
  });

  it("leaves the deployment-wide limit alone for a plan that sets none", async () => {
    await truncateBillingTables();
    await seedBillingAccount({ orgId, planId: "pro" });
    expect(await beforeUsage(runParams({ runningCount: 49 }))).toBeNull();
  });
});

describe("runLimits hook", () => {
  beforeEach(async () => {
    await truncateEeTables();
  });

  function runLimits(orgId: string) {
    return eeModule.hooks!.runLimits!(orgId);
  }

  it("hands the Free plan's three concurrent runs to the platform", async () => {
    await seedBillingAccount({ orgId, planId: "free" });
    expect(await runLimits(orgId)).toEqual({ maxConcurrentRuns: FREE_MAX_CONCURRENT_RUNS });
  });

  it("leaves the deployment-wide cap for a plan that sets none, and for an org with no account", async () => {
    await seedBillingAccount({ orgId, planId: "pro" });
    expect(await runLimits(orgId)).toEqual({ maxConcurrentRuns: null });
    expect(await runLimits("00000000-0000-4000-a000-000000000b99")).toEqual({
      maxConcurrentRuns: null,
    });
  });
});
