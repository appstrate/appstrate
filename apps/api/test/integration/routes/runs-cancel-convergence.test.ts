// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /api/runs/:id/cancel` must converge on `finalizeRun` so the
 * `afterRun` hook fires for cancelled runs that already burned LLM tokens.
 *
 * Pre-fix the cancel route wrote `status='cancelled'` directly and skipped
 * `afterRun`, leaking billing on every user-cancelled run that had reached
 * the LLM at least once. These tests pin the fix in place by spying on the
 * hook with a fake module — if a future refactor reintroduces the bypass,
 * the spy stops being called and the suite fails.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, llmUsage } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import type { AppstrateModule, RunStatusChangeParams } from "@appstrate/core/module";

const app = getTestApp();

const RUN_SECRET = "a".repeat(43); // matches mintSinkCredentials base64url(32B)

function signedHeaders(secret: string, body: string) {
  const msgId = `msg_${crypto.randomUUID()}`;
  const timestampSec = Math.floor(Date.now() / 1000);
  const headers = sign({ msgId, timestampSec, body, secret });
  return {
    "Content-Type": "application/json",
    "webhook-id": headers["webhook-id"],
    "webhook-timestamp": headers["webhook-timestamp"],
    "webhook-signature": headers["webhook-signature"],
  };
}

async function seedCancellableRun(
  ctx: TestContext,
  packageId: string,
  overrides: {
    status?: "pending" | "running";
    modelSource?: string | null;
  } = {},
): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: overrides.status ?? "running",
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    startedAt: new Date(),
    tokenUsage: { input_tokens: 100, output_tokens: 50 },
    ...(overrides.modelSource !== undefined ? { modelSource: overrides.modelSource } : {}),
  });
  return runId;
}

async function seedLlmUsage(
  ctx: TestContext,
  runId: string,
  costUsd: number,
  source: "runner" | "proxy" = "runner",
): Promise<void> {
  await db.insert(llmUsage).values({
    source,
    orgId: ctx.orgId,
    runId,
    inputTokens: 100,
    outputTokens: 50,
    costUsd,
  });
}

interface AfterRunSpy {
  callCount(): number;
  lastParams(): RunStatusChangeParams | null;
  allParams(): RunStatusChangeParams[];
}

async function installAfterRunSpy(): Promise<AfterRunSpy> {
  const calls: RunStatusChangeParams[] = [];
  const mod: AppstrateModule = {
    manifest: { id: "cancel-spy", name: "Cancel Spy", version: "1.0.0" },
    async init() {},
    hooks: {
      afterRun: async (params) => {
        calls.push(params);
        return null;
      },
    },
  };
  await loadModulesFromInstances([mod], {
    databaseUrl: null,
    redisUrl: null,
    appUrl: "http://localhost:3000",
    isEmbeddedDb: true,
    applyMigrations: async () => {},
    getSendMail: async () => () => {},
    getOrgAdminEmails: async () => [],
    services: {} as never,
  });
  return {
    callCount: () => calls.length,
    lastParams: () => calls[calls.length - 1] ?? null,
    allParams: () => calls.slice(),
  };
}

describe("POST /api/runs/:id/cancel — terminal-state convergence", () => {
  let ctx: TestContext;
  const agentId = "@cancel/spy-agent";

  beforeEach(async () => {
    await truncateAll();
    resetModules();
    ctx = await createTestContext({ email: "cancel@test.dev", orgSlug: "cancel-org" });
    await seedPackage({ orgId: ctx.orgId, id: agentId, type: "agent" });
  });

  afterAll(() => {
    // Don't leak the spy module into sibling test files.
    resetModules();
  });

  it("cancelling a running run with cost fires afterRun with the SUM(llm_usage) cost", async () => {
    const spy = await installAfterRunSpy();
    const runId = await seedCancellableRun(ctx, agentId, { modelSource: "system" });
    await seedLlmUsage(ctx, runId, 0.0551);

    const res = await app.request(`/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);

    expect(spy.callCount()).toBe(1);
    const params = spy.lastParams()!;
    expect(params.runId).toBe(runId);
    expect(params.orgId).toBe(ctx.orgId);
    expect(params.applicationId).toBe(ctx.defaultAppId);
    expect(params.status).toBe("cancelled");
    expect(params.modelSource).toBe("system");
    // Cost rounded — `runs.cost` is doublePrecision, llm_usage stores the
    // exact value, so the SUM here matches what we seeded.
    expect(params.cost).toBeCloseTo(0.0551, 4);

    // The terminal state landed on `runs` via finalizeRun's CAS.
    const [row] = await db
      .select({ status: runs.status, cost: runs.cost, sinkClosedAt: runs.sinkClosedAt })
      .from(runs)
      .where(eq(runs.id, runId));
    expect(row!.status).toBe("cancelled");
    expect(row!.cost).toBeCloseTo(0.0551, 4);
    expect(row!.sinkClosedAt).not.toBeNull();
  });

  it("cancelling a pending run (never reached the LLM) fires afterRun without cost", async () => {
    const spy = await installAfterRunSpy();
    const runId = await seedCancellableRun(ctx, agentId, {
      status: "pending",
      modelSource: "system",
    });

    const res = await app.request(`/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);

    expect(spy.callCount()).toBe(1);
    const params = spy.lastParams()!;
    expect(params.status).toBe("cancelled");
    // No llm_usage rows seeded → `cost` is omitted from the hook params.
    expect(params.cost).toBeUndefined();

    const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    expect(row!.status).toBe("cancelled");
  });

  it("cancelling a BYOK run forwards modelSource='org' so the cloud module skips billing", async () => {
    const spy = await installAfterRunSpy();
    const runId = await seedCancellableRun(ctx, agentId, { modelSource: "org" });
    await seedLlmUsage(ctx, runId, 0.1);

    const res = await app.request(`/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);

    expect(spy.callCount()).toBe(1);
    const params = spy.lastParams()!;
    expect(params.modelSource).toBe("org");
    expect(params.cost).toBeCloseTo(0.1, 4);
  });

  it("two concurrent cancels — finalizeRun's CAS lets exactly one terminal state land", async () => {
    // The platform calls `afterRun` BEFORE the CAS in `finalizeRun`, so
    // racing cancels can both invoke the hook with identical params (this
    // is the design from issue #12 — `afterRun` consumers MUST be
    // idempotent on `runId`, which the cloud module enforces via a unique
    // index on `cloud_usage_records.run_id`). What this test pins is the
    // CAS-side invariant: at most one finalize advances the row to
    // terminal state, the second is a no-op.
    const spy = await installAfterRunSpy();
    const runId = await seedCancellableRun(ctx, agentId, { modelSource: "system" });
    await seedLlmUsage(ctx, runId, 0.02);

    const [a, b] = await Promise.all([
      app.request(`/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      }),
      app.request(`/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      }),
    ]);

    // The second cancel either races and observes a still-cancellable
    // state (200) or arrives after the first updated the row (409) —
    // both are valid responses.
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]!).toBe(200);
    expect([200, 409]).toContain(statuses[1]!);

    // afterRun MAY fire 1× or 2× depending on race ordering. Every call
    // it does fire MUST carry the same parameters — concurrent finalizers
    // observe the same source-of-truth (`runs` row + `llm_usage` ledger).
    expect(spy.callCount()).toBeGreaterThanOrEqual(1);
    expect(spy.callCount()).toBeLessThanOrEqual(2);
    for (const params of spy.allParams()) {
      expect(params.runId).toBe(runId);
      expect(params.status).toBe("cancelled");
      expect(params.cost).toBeCloseTo(0.02, 4);
    }

    // Exactly one terminal state landed on the row (CAS won by one caller).
    const [row] = await db
      .select({ status: runs.status, sinkClosedAt: runs.sinkClosedAt })
      .from(runs)
      .where(eq(runs.id, runId));
    expect(row!.status).toBe("cancelled");
    expect(row!.sinkClosedAt).not.toBeNull();
  });

  it("cancel followed by a runner-posted finalize is a CAS no-op (afterRun fires once)", async () => {
    const spy = await installAfterRunSpy();
    const runId = await seedCancellableRun(ctx, agentId, { modelSource: "system" });
    await seedLlmUsage(ctx, runId, 0.03);

    // User cancels first.
    const cancelRes = await app.request(`/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(cancelRes.status).toBe(200);

    // Runner POSTs its own finalize after the cancel — common when the
    // runner had a finalize in flight at the moment the user cancelled.
    const body = JSON.stringify({
      status: "success",
      output: { ok: true },
      durationMs: 100,
    });
    const finalizeRes = await app.request(`/api/runs/${runId}/events/finalize`, {
      method: "POST",
      headers: signedHeaders(RUN_SECRET, body),
      body,
    });
    // Sink already closed by the cancel — runner's POST is rejected as gone.
    expect(finalizeRes.status).toBe(410);

    // `afterRun` fired exactly once, on the cancel path.
    expect(spy.callCount()).toBe(1);
    expect(spy.lastParams()!.status).toBe("cancelled");

    const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    expect(row!.status).toBe("cancelled");
  });

  it("returns 409 for already-terminal runs without firing afterRun", async () => {
    const spy = await installAfterRunSpy();
    const runId = await seedCancellableRun(ctx, agentId);
    // Flip the run to a terminal state directly (simulating "already done").
    await db.update(runs).set({ status: "success" }).where(eq(runs.id, runId));

    const res = await app.request(`/api/runs/${runId}/cancel`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(409);
    expect(spy.callCount()).toBe(0);
  });
});
