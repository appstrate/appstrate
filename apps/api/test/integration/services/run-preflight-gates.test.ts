// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the shared preflight gates that every run path
 * (platform, remote, scheduled) runs before spending any further
 * resources. These gates used to be copy-pasted between the platform
 * pipeline and the remote-run handler — the factorisation here prevents
 * future drift between them.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";
import { runPreflightGates } from "../../../src/services/run-preflight-gates.ts";
import { getPlatformRunLimits } from "../../../src/services/run-limits.ts";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import type { LoadedPackage } from "../../../src/types/index.ts";
import type {
  AppstrateModule,
  ModuleInitContext,
  BeforeUsageParams,
  UsageRejection,
} from "@appstrate/core/module";

function loadedPackage(id: string, timeoutOverride?: number): LoadedPackage {
  return {
    id,
    manifest: {
      name: id,
      version: "0.1.0",
      schema_version: "0.1",
      display_name: id,
      type: "agent",
      ...(timeoutOverride !== undefined ? { timeout: timeoutOverride } : {}),
    } as unknown as LoadedPackage["manifest"],
    prompt: "x",
    source: "local",
  };
}

describe("runPreflightGates", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    // No module → no `beforeUsage` hook. These cases assert the non-hook gates,
    // and the hook now fires for every run, so a module leaked in by an earlier
    // file would otherwise perturb `beforeUsageHookMs`.
    resetModules();
    ctx = await createTestContext({ email: "gates@test.dev", orgSlug: "gates" });
    await seedPackage({ orgId: ctx.orgId, id: "@gates/agent", type: "agent" });
  });

  afterAll(() => {
    resetModules();
  });

  it("returns ok with an untouched agent when the manifest timeout is below the ceiling", async () => {
    const agent = loadedPackage("@gates/agent", 60);
    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent,
      credentialSource: "system",
      executionPlane: "platform",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.agent.manifest.timeout).toBe(60);
  });

  it("returns per-sub-gate timings on the ok result (rate-limit + concurrency run in parallel)", async () => {
    const agent = loadedPackage("@gates/agent", 60);
    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent,
      credentialSource: "system",
      executionPlane: "platform",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // No `beforeUsage` hook is registered in core tests → hook timing is 0.
      expect(res.timings.beforeUsageHookMs).toBe(0);
      expect(typeof res.timings.rateLimitMs).toBe("number");
      expect(typeof res.timings.concurrencyMs).toBe("number");
      expect(res.timings.rateLimitMs).toBeGreaterThanOrEqual(0);
      expect(res.timings.concurrencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("caps the agent timeout to the platform ceiling without mutating the input", async () => {
    const limits = getPlatformRunLimits();
    const agent = loadedPackage("@gates/agent", limits.timeout_ceiling_seconds + 60);
    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent,
      credentialSource: "system",
      executionPlane: "platform",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.agent.manifest.timeout).toBe(limits.timeout_ceiling_seconds);
      // The caller's reference is untouched — rebinding happens via the
      // returned value, not by mutating the shared object.
      expect(agent.manifest.timeout).toBe(limits.timeout_ceiling_seconds + 60);
    }
  });
});

/**
 * `beforeUsage` execution-fact reporting. The hook fires for EVERY run — the
 * platform stopped deciding that a non-system model is free and skipping it
 * (that hard-coded "BYOK ⇒ free", which stops being true the moment platform
 * compute is billed). It now reports neutral facts — `credentialSource`,
 * `executionPlane`, and the EFFECTIVE post-ceiling `timeoutSeconds` — and a
 * metering module (cloud) quotes them.
 *
 * These assertions pin the facts a module quotes against: dropping one, or
 * reporting a pre-ceiling timeout, would silently over- or under-charge rather
 * than fail loudly.
 */
function fakeInitCtx(): ModuleInitContext {
  return {
    redisUrl: null,
    appUrl: "http://localhost:3000",
    getSendMail: async () => () => {},
    getOrgAdminEmails: async () => [],
    services: {} as ModuleInitContext["services"],
  };
}

/** A module whose `beforeUsage` records its args and returns a scripted result. */
function gateModule(result: UsageRejection | null, calls: BeforeUsageParams[]): AppstrateModule {
  return {
    manifest: { id: "test-gate", name: "Gate", version: "0.0.0" },
    async init() {},
    hooks: {
      beforeUsage: async (params) => {
        calls.push(params);
        return result;
      },
    },
  };
}

describe("runPreflightGates — beforeUsage execution facts", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    resetModules();
    ctx = await createTestContext({ email: "gate-src@test.dev", orgSlug: "gate-src" });
    await seedPackage({ orgId: ctx.orgId, id: "@gates/agent", type: "agent" });
  });

  afterAll(() => {
    resetModules();
  });

  it("dispatches beforeUsage (run context) for a system model and returns its 402 rejection", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [gateModule({ code: "over_cap", message: "Credit cap reached", status: 402 }, calls)],
      fakeInitCtx(),
    );

    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent: loadedPackage("@gates/agent", 60),
      credentialSource: "system",
      executionPlane: "platform",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toEqual({ code: "over_cap", message: "Credit cap reached", status: 402 });
    }
    // Dispatched with the run discriminant (not the chat shape).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      orgId: ctx.orgId,
      context: "run",
      packageId: "@gates/agent",
      // No run existed in the DB, but the hook receives the projected count
      // including the run currently being admitted.
      runningCount: 1,
      credentialSource: "system",
      executionPlane: "platform",
      timeoutSeconds: 60,
    });
  });

  it("dispatches the hook for an org-owned (BYOK) platform run with credentialSource 'org'", async () => {
    // Reversal of the old topology: a BYOK run is no longer declared free by
    // the platform. It occupies platform compute, so the module is told the
    // facts and quotes it (a model-only meter quotes zero and admits).
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent: loadedPackage("@gates/agent", 60),
      credentialSource: "org",
      executionPlane: "platform",
    });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      orgId: ctx.orgId,
      context: "run",
      packageId: "@gates/agent",
      runningCount: 1,
      credentialSource: "org",
      executionPlane: "platform",
      timeoutSeconds: 60,
    });
  });

  it("dispatches the hook for a remote-origin run (credentialSource null, remote plane)", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent: loadedPackage("@gates/agent", 60),
      credentialSource: null,
      executionPlane: "remote",
    });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    // Neither platform credential nor platform compute — the two facts that let
    // a module short-circuit a fully self-funded run before any billing read.
    expect(calls[0]).toEqual({
      orgId: ctx.orgId,
      context: "run",
      packageId: "@gates/agent",
      runningCount: 1,
      credentialSource: null,
      executionPlane: "remote",
      timeoutSeconds: 60,
    });
  });

  it("reports the POST-ceiling timeout when the manifest declares more than the platform allows", async () => {
    // The cap is applied before the hook: quoting compute on the declared value
    // would charge for time the run can never occupy.
    const limits = getPlatformRunLimits();
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent: loadedPackage("@gates/agent", limits.timeout_ceiling_seconds + 600),
      credentialSource: "system",
      executionPlane: "platform",
    });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { timeoutSeconds: number | null }).timeoutSeconds).toBe(
      limits.timeout_ceiling_seconds,
    );
  });

  it("reports the default timeout when the manifest declares none", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());

    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent: loadedPackage("@gates/agent"),
      credentialSource: "system",
      executionPlane: "platform",
    });

    expect(res.ok).toBe(true);
    expect((calls[0] as { timeoutSeconds: number | null }).timeoutSeconds).toBe(300);
  });

  it("reports runningCount as the projected count INCLUDING the run being admitted", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances([gateModule(null, calls)], fakeInitCtx());
    // Two runs already in flight → the hook must see 3, not the observed 2.
    await seedRun({
      packageId: "@gates/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
    });
    await seedRun({
      packageId: "@gates/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
    });

    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent: loadedPackage("@gates/agent", 60),
      credentialSource: "system",
      executionPlane: "platform",
    });

    expect(res.ok).toBe(true);
    expect((calls[0] as { runningCount: number }).runningCount).toBe(3);
  });

  it("returns ok for a system model when no metering module provides the hook (OSS mode)", async () => {
    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent: loadedPackage("@gates/agent", 60),
      credentialSource: "system",
      executionPlane: "platform",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.timings.beforeUsageHookMs).toBe(0);
  });
});
