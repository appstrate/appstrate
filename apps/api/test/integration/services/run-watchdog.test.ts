// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the run stall watchdog — the unified crash
 * detection path for every runner topology (platform container,
 * remote CLI, GitHub Action). The watchdog reads
 * `runs.last_heartbeat_at` and routes stalled rows through
 * `finalizeRun({status: failed})`, which is the same convergence
 * point used by natural termination, container-exit synthesis, and
 * runner-posted finalize.
 *
 * Covers:
 *   1. A run whose heartbeat slipped past the stall threshold is
 *      finalized as `failed`, the sink is closed, a `run_completed`
 *      log row lands exactly once, and the `onRunStatusChange` event
 *      reflects the terminal state.
 *   2. A run whose heartbeat is fresh is untouched.
 *   3. A run whose sink is already closed is untouched (no double
 *      finalize — CAS idempotency).
 *   4. The sweep is bounded by `maxFinalizesPerTick`.
 *   5. The sweep also stops the stalled run's workload through the
 *      orchestrator (same route as user cancel) — a stalled runner is
 *      not necessarily dead, and a remote microVM left running keeps
 *      executing and billing.
 *   6. The startup phase: a run still being provisioned (no runner event
 *      yet, heartbeat kept fresh by the platform's boot attestation) is
 *      NOT killed by the stall predicate, but IS killed once it blows
 *      `boot_deadline_at` — with an error naming provisioning rather than
 *      blaming a runner that never got to exist.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, runLogs, llmUsage } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { runWatchdogTick } from "../../../src/services/run-watchdog.ts";
import {
  _setOrchestratorForTesting,
  type RunOrchestrator,
  type WorkloadHandle,
  type WorkloadSpec,
  type IsolationBoundary,
  type CleanupReport,
  type StopResult,
} from "../../../src/services/orchestrator/index.ts";

// Boot the test app so its lazy module loads happen once — irrelevant
// to the watchdog itself but keeps DB migrations applied.
getTestApp();

const RUN_SECRET = "a".repeat(43);

async function seedRun(
  ctx: TestContext,
  packageId: string,
  overrides: {
    status?: "pending" | "running" | "success" | "failed" | "timeout" | "cancelled";
    lastHeartbeatAt?: Date;
    sinkClosedAt?: Date | null;
    sinkExpiresAt?: Date | null;
    bootDeadlineAt?: Date | null;
    lastEventSequence?: number;
    startedAt?: Date;
  } = {},
): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  // Explicit `in` check — using `??` would coerce an explicit `null`
  // to the default, which is the opposite of what callers expect when
  // they want to exercise the "no open sink" branch.
  const sinkExpiresAt =
    "sinkExpiresAt" in overrides ? overrides.sinkExpiresAt : new Date(Date.now() + 3600_000);
  await db.insert(runs).values({
    id: runId,
    packageId,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: overrides.status ?? "running",
    runOrigin: "remote",
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt,
    sinkClosedAt: overrides.sinkClosedAt ?? null,
    startedAt: overrides.startedAt ?? new Date(),
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? new Date(),
    // Mirrors production: a row with an open sink always carries a
    // provisioning ceiling. Explicit `in` check so a test can exercise the
    // pre-migration NULL case.
    bootDeadlineAt:
      "bootDeadlineAt" in overrides ? overrides.bootDeadlineAt : new Date(Date.now() + 300_000),
    lastEventSequence: overrides.lastEventSequence ?? 1,
    tokenUsage: { input_tokens: 100, output_tokens: 50 } as unknown as Record<string, number>,
  });
  return runId;
}

describe("run watchdog — unified stall detection", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "watchdog@test.dev", orgSlug: "watchdog-org" });
    await seedPackage({ orgId: ctx.orgId, id: "@test/watchdog-agent", type: "agent" });
  });

  it("finalizes runs whose last heartbeat slipped past the stall threshold", async () => {
    const oldHeartbeat = new Date(Date.now() - 300_000); // 5 minutes ago
    const runId = await seedRun(ctx, "@test/watchdog-agent", {
      status: "running",
      lastHeartbeatAt: oldHeartbeat,
    });

    const finalizedCount = await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 100,
    });

    expect(finalizedCount).toBe(1);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.sinkClosedAt).not.toBeNull();
    expect(row?.error).toContain("Runner stopped reporting");

    // The sink-close CAS inside finalizeRun also writes the terminal
    // log row — assert exactly one run_completed landed so we catch
    // accidental double-fires (a defensive regression: the CAS was
    // the fix for the 8-point bundle before this feature).
    const completed = await db.select().from(runLogs).where(eq(runLogs.runId, runId));
    const runCompletedRows = completed.filter((r) => r.event === "run_completed");
    expect(runCompletedRows.length).toBe(1);
  });

  it("leaves runs with fresh heartbeats untouched", async () => {
    const runId = await seedRun(ctx, "@test/watchdog-agent", {
      status: "running",
      lastHeartbeatAt: new Date(), // just now
    });

    const finalizedCount = await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 100,
    });

    expect(finalizedCount).toBe(0);
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("running");
    expect(row?.sinkClosedAt).toBeNull();
  });

  it("ignores runs whose sink is already closed (CAS idempotency boundary)", async () => {
    const runId = await seedRun(ctx, "@test/watchdog-agent", {
      status: "success",
      lastHeartbeatAt: new Date(Date.now() - 3600_000),
      sinkClosedAt: new Date(),
    });

    const finalizedCount = await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 100,
    });

    expect(finalizedCount).toBe(0);
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
  });

  it("ignores runs with no sinkExpiresAt — only open sinks are eligible", async () => {
    // This is the partial-index filter; a row without sinkExpiresAt
    // represents a run the protocol never activated, which must not
    // be touched by the liveness sweep.
    const runId = await seedRun(ctx, "@test/watchdog-agent", {
      status: "running",
      lastHeartbeatAt: new Date(Date.now() - 3600_000),
      sinkExpiresAt: null,
    });

    const finalizedCount = await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 100,
    });

    expect(finalizedCount).toBe(0);
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("running");
  });

  it("caps the number of finalizes per tick", async () => {
    // Seed three stale runs, cap at 2 — only the first batch gets
    // finalized this tick, the third stays pending for the next.
    const stale = new Date(Date.now() - 3600_000);
    const ids = await Promise.all([
      seedRun(ctx, "@test/watchdog-agent", { status: "running", lastHeartbeatAt: stale }),
      seedRun(ctx, "@test/watchdog-agent", { status: "running", lastHeartbeatAt: stale }),
      seedRun(ctx, "@test/watchdog-agent", { status: "running", lastHeartbeatAt: stale }),
    ]);

    const finalizedCount = await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 2,
    });

    expect(finalizedCount).toBe(2);
    const rows = await db.select().from(runs).where(eq(runs.orgId, ctx.orgId));
    const failed = rows.filter((r) => ids.includes(r.id) && r.status === "failed");
    const stillRunning = rows.filter((r) => ids.includes(r.id) && r.status === "running");
    expect(failed.length).toBe(2);
    expect(stillRunning.length).toBe(1);
  });

  // Regression coverage for #391 — "users perceive that failed/timed-
  // out runs are not counted". Verifies the existing convergence:
  // metric events that arrived BEFORE the container crashed have
  // already written `llm_usage` rows; the watchdog's call to
  // `finalizeRun` reads `computeRunSpend` from that ledger and
  // persists `runs.cost` on the failed terminal status, so the
  // `onRunStatusChange` broadcast carries the right value even
  // when the container never posted /finalize itself.
  it("captures cost for a crashed run whose metric event landed before the crash", async () => {
    const stale = new Date(Date.now() - 3600_000);
    const runId = await seedRun(ctx, "@test/watchdog-agent", {
      status: "running",
      lastHeartbeatAt: stale,
    });

    // Simulate a metric event having landed before the container
    // crashed: a runner-source `llm_usage` row exists with a non-zero
    // cost. The watchdog must finalize the run AND surface that cost
    // on the terminal `runs.cost` column for the billing hook.
    await db.insert(llmUsage).values({
      source: "runner",
      orgId: ctx.orgId,
      runId,
      inputTokens: 1500,
      outputTokens: 800,
      costUsd: 0.0234,
    });

    const finalizedCount = await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 100,
    });

    expect(finalizedCount).toBe(1);
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    // Cost MUST survive the terminal status — it's the input cloud
    // billing reads off the run row to charge the org.
    expect(row?.cost).toBeCloseTo(0.0234, 5);
  });

  // #1020 — the stall sweep builds its own `emptyRunResult()` (it does not
  // go through `synthesiseFinalize`), so it has to recover the deliverable
  // the agent already emitted or the payload stays invisible on a durable
  // `run_logs` row. Recovery is payload-only: the terminal stays `failed`.
  it("recovers an emitted output payload onto the failed terminal", async () => {
    const runId = await seedRun(ctx, "@test/watchdog-agent", {
      status: "running",
      lastHeartbeatAt: new Date(Date.now() - 3600_000),
    });
    // The row the `output.emitted` ingestion path writes at emit time.
    await db.insert(runLogs).values({
      runId,
      orgId: ctx.orgId,
      type: "result",
      event: "output",
      data: { answer: "42" },
      level: "info",
    });

    const finalizedCount = await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 100,
    });

    expect(finalizedCount).toBe(1);
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("Runner stopped reporting");
    expect((row?.result as { output?: unknown } | null)?.output).toEqual({ answer: "42" });
  });

  it("leaves runs.result null when a stalled run emitted no output", async () => {
    const runId = await seedRun(ctx, "@test/watchdog-agent", {
      status: "running",
      lastHeartbeatAt: new Date(Date.now() - 3600_000),
    });

    await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 100,
    });

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.result).toBeNull();
  });

  // B1 regression — a stalled runner is not necessarily a dead one. A
  // remote workload (e.g. a firecracker microVM that lost its event
  // path) keeps executing and billing after the row is finalized, so
  // the sweep must also route a stop through the orchestrator — the
  // same path the user-cancel route takes.
  it("stops the stalled run's workload through the orchestrator", async () => {
    const stoppedRunIds: string[] = [];
    _setOrchestratorForTesting(createRecordingOrchestrator(stoppedRunIds));
    try {
      const runId = await seedRun(ctx, "@test/watchdog-agent", {
        status: "running",
        lastHeartbeatAt: new Date(Date.now() - 3600_000),
      });

      const finalizedCount = await runWatchdogTick({
        intervalSeconds: 30,
        stallThresholdSeconds: 60,
        maxFinalizesPerTick: 100,
      });

      expect(finalizedCount).toBe(1);
      // stopByRunId is fire-and-forget from the sweep's perspective —
      // the recording stub resolves synchronously enough that the call
      // has landed once the tick returns.
      expect(stoppedRunIds).toEqual([runId]);

      const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
      expect(row?.status).toBe("failed");
    } finally {
      _setOrchestratorForTesting(null);
    }
  });

  it("does not stop workloads when nothing stalled", async () => {
    const stoppedRunIds: string[] = [];
    _setOrchestratorForTesting(createRecordingOrchestrator(stoppedRunIds));
    try {
      await seedRun(ctx, "@test/watchdog-agent", {
        status: "running",
        lastHeartbeatAt: new Date(), // fresh
      });

      const finalizedCount = await runWatchdogTick({
        intervalSeconds: 30,
        stallThresholdSeconds: 60,
        maxFinalizesPerTick: 100,
      });

      expect(finalizedCount).toBe(0);
      expect(stoppedRunIds).toEqual([]);
    } finally {
      _setOrchestratorForTesting(null);
    }
  });

  // ── Startup phase (the second predicate) ────────────────────────────
  //
  // Between run creation and the runner's first event the platform is
  // provisioning: pulling images, creating the boundary, booting the
  // workload. No runner exists to heartbeat, so the platform attests
  // liveness on its behalf and the stall predicate must NOT fire — the
  // boot deadline is what bounds that window instead.

  it("leaves a still-provisioning run alone while its heartbeat is fresh", async () => {
    // What a slow-but-healthy cold boot looks like: no runner event yet,
    // deadline still ahead, boot pump keeping the heartbeat fresh. This is
    // the regression: before the split, a cold image pull outrunning the
    // 60s stall threshold killed this run and blamed the runner.
    const runId = await seedRun(ctx, "@test/watchdog-agent", {
      status: "pending",
      lastEventSequence: 0,
      lastHeartbeatAt: new Date(),
      bootDeadlineAt: new Date(Date.now() + 240_000),
    });

    const finalizedCount = await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 100,
    });

    expect(finalizedCount).toBe(0);
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("pending");
  });

  it("fails a run that blew its provisioning deadline, with a provisioning error", async () => {
    const runId = await seedRun(ctx, "@test/watchdog-agent", {
      status: "pending",
      lastEventSequence: 0,
      // Fresh heartbeat: the pump was still vouching for it right up to the
      // ceiling, so ONLY the boot-deadline predicate can catch this row.
      lastHeartbeatAt: new Date(),
      startedAt: new Date(Date.now() - 310_000),
      bootDeadlineAt: new Date(Date.now() - 10_000),
    });

    const finalizedCount = await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 100,
    });

    expect(finalizedCount).toBe(1);
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.sinkClosedAt).not.toBeNull();
    // The error must describe what actually happened — the whole point of
    // the split. "Runner stopped reporting" would be a lie here: no runner
    // ever reported anything.
    expect(row?.error).toContain("never started executing");
    expect(row?.error).not.toContain("Runner stopped reporting");
    // Budget is derived per-row (deadline − started_at), so the message
    // stays true for rows created under a different env setting.
    expect(row?.error).toContain("300s");
  });

  it("still reports a stall (not a boot failure) once the runner has reported", async () => {
    const runId = await seedRun(ctx, "@test/watchdog-agent", {
      status: "running",
      lastEventSequence: 4,
      lastHeartbeatAt: new Date(Date.now() - 300_000),
      // Deadline long past too — irrelevant once the runner has spoken.
      bootDeadlineAt: new Date(Date.now() - 200_000),
    });

    const finalizedCount = await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 100,
    });

    expect(finalizedCount).toBe(1);
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.error).toContain("Runner stopped reporting");
  });

  it("keeps the stall predicate for pre-migration rows with no boot deadline", async () => {
    const runId = await seedRun(ctx, "@test/watchdog-agent", {
      status: "pending",
      lastEventSequence: 0,
      bootDeadlineAt: null,
      lastHeartbeatAt: new Date(Date.now() - 300_000),
    });

    const finalizedCount = await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 100,
    });

    expect(finalizedCount).toBe(1);
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("Runner stopped reporting");
  });

  it("stops the workload of a run that blew its provisioning deadline", async () => {
    // Same credential-exposure reasoning as the stall path: a run stuck in
    // provisioning may have a live sandbox holding credentials.
    const stoppedRunIds: string[] = [];
    _setOrchestratorForTesting(createRecordingOrchestrator(stoppedRunIds));
    try {
      const runId = await seedRun(ctx, "@test/watchdog-agent", {
        status: "pending",
        lastEventSequence: 0,
        lastHeartbeatAt: new Date(),
        bootDeadlineAt: new Date(Date.now() - 10_000),
      });

      const finalizedCount = await runWatchdogTick({
        intervalSeconds: 30,
        stallThresholdSeconds: 60,
        maxFinalizesPerTick: 100,
      });

      expect(finalizedCount).toBe(1);
      expect(stoppedRunIds).toEqual([runId]);
    } finally {
      _setOrchestratorForTesting(null);
    }
  });

  it("ignores a blown deadline on a run whose sink is already closed", async () => {
    const runId = await seedRun(ctx, "@test/watchdog-agent", {
      status: "success",
      lastEventSequence: 0,
      lastHeartbeatAt: new Date(),
      bootDeadlineAt: new Date(Date.now() - 10_000),
      sinkClosedAt: new Date(),
    });

    const finalizedCount = await runWatchdogTick({
      intervalSeconds: 30,
      stallThresholdSeconds: 60,
      maxFinalizesPerTick: 100,
    });

    expect(finalizedCount).toBe(0);
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
  });
});

/**
 * Minimal RunOrchestrator stub — every method present and inert, with
 * `stopByRunId` recording the run ids it was called with. Same shape as
 * the fake in `test/integration/routes/runs.test.ts`.
 */
function createRecordingOrchestrator(stoppedRunIds: string[]): RunOrchestrator {
  const handle = (runId: string, role: string): WorkloadHandle => ({
    id: `${role}_${runId}`,
    runId,
    role,
  });
  return {
    async initialize() {},
    async shutdown() {},
    async cleanupOrphans(): Promise<CleanupReport> {
      return { workloads: 0, isolationBoundaries: 0, workspaces: 0 };
    },
    async ensureImages() {},
    async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
      return {
        id: `net_${runId}`,
        name: `appstrate-exec-${runId}`,
        workspace: { kind: "directory", path: `/tmp/test-ws-${runId}` },
        sidecarEndpoints: {
          sidecarUrl: "http://sidecar:8080",
          llmProxyUrl: "http://sidecar:8080/llm",
          forwardProxyUrl: "http://sidecar:8081",
          noProxy: "sidecar,localhost,127.0.0.1",
        },
      };
    },
    async removeIsolationBoundary() {},
    async createSidecar(runId: string): Promise<WorkloadHandle> {
      return handle(runId, "sidecar");
    },
    async createWorkload(spec: WorkloadSpec): Promise<WorkloadHandle> {
      return handle(spec.runId, spec.role);
    },
    async startWorkload() {},
    async stopWorkload() {},
    async removeWorkload() {},
    async waitForExit(): Promise<number> {
      return 0;
    },
    async *streamLogs(): AsyncGenerator<string> {},
    async stopByRunId(runId: string): Promise<StopResult> {
      stoppedRunIds.push(runId);
      return "stopped";
    },
    async resolvePlatformApiUrl(): Promise<string> {
      return "http://platform:3000";
    },
  };
}
