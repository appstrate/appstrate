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
import { seedPackage } from "../../helpers/seed.ts";
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
    ctx = await createTestContext({ email: "gates@test.dev", orgSlug: "gates" });
    await seedPackage({ orgId: ctx.orgId, id: "@gates/agent", type: "agent" });
  });

  it("returns ok with an untouched agent when the manifest timeout is below the ceiling", async () => {
    const agent = loadedPackage("@gates/agent", 60);
    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.agent.manifest.timeout).toBe(60);
  });

  it("returns per-sub-gate timings on the ok result (rate-limit + concurrency run in parallel)", async () => {
    const agent = loadedPackage("@gates/agent", 60);
    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent,
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
 * `beforeUsage` model-source gating (fix: BYOK/OAuth/remote runs must NOT hit
 * the credit-cap gate). The hook fires ONLY for a platform-provided (`"system"`)
 * model — the same rule the chat surface applies. A metering module (cloud)
 * relies on these branches, so a regression that gated an org's own model — or
 * failed to gate a system one — surfaces here rather than as a billing/402
 * incident.
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

describe("runPreflightGates — beforeUsage model-source gating", () => {
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
      modelSource: "system",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toEqual({ code: "over_cap", message: "Credit cap reached", status: 402 });
    }
    // Dispatched with the run discriminant (not the chat shape).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      orgId: ctx.orgId,
      context: "run",
      packageId: "@gates/agent",
      // No run existed in the DB, but the hook receives the projected count
      // including the run currently being admitted.
      runningCount: 1,
    });
  });

  it("does NOT dispatch the hook for an org-owned (BYOK) model", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      // Even a rejecting metering module must not block an org's own credential.
      [gateModule({ code: "over_cap", message: "blocked", status: 402 }, calls)],
      fakeInitCtx(),
    );

    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent: loadedPackage("@gates/agent", 60),
      modelSource: "org",
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.timings.beforeUsageHookMs).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("does NOT dispatch the hook for a remote-origin run (modelSource null)", async () => {
    const calls: BeforeUsageParams[] = [];
    await loadModulesFromInstances(
      [gateModule({ code: "over_cap", message: "blocked", status: 402 }, calls)],
      fakeInitCtx(),
    );

    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent: loadedPackage("@gates/agent", 60),
      modelSource: null,
    });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("returns ok for a system model when no metering module provides the hook (OSS mode)", async () => {
    const res = await runPreflightGates({
      orgId: ctx.orgId,
      agent: loadedPackage("@gates/agent", 60),
      modelSource: "system",
    });
    expect(res.ok).toBe(true);
  });
});
