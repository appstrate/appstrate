// SPDX-License-Identifier: Apache-2.0

/**
 * Run context budget (#1046) — `context_window` / `compaction_threshold` on the
 * run wire DTO, and the DB invariants that keep them meaningful.
 *
 * The gauge's numerator (`contextTokens` on the run's `appstrate.progress`
 * breadcrumbs) already flows end to end; what is pinned here is the
 * denominator: it must reach the SPA on both read paths (detail + list), it
 * must stay NULL — not zero — when unknown, and the database must refuse a
 * present-but-nonsensical pair.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runLogs, runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedPackage, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { createApiKeyCredential } from "../../../src/services/model-providers/credentials.ts";
import { createOrgModel, setDefaultModel } from "../../../src/services/org-models.ts";
import { waitForInFlight } from "../../../src/services/run-tracker.ts";
import {
  _setOrchestratorForTesting,
  type RunOrchestrator,
  type WorkloadHandle,
  type WorkloadSpec,
  type IsolationBoundary,
  type CleanupReport,
  type StopResult,
} from "../../../src/services/orchestrator/index.ts";

const app = getTestApp();

const AGENT = "@ctxorg/ctx-agent";

interface ContextBudgetWire {
  context_window: number | null;
  compaction_threshold: number | null;
}

describe("run context budget — wire DTO", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "ctxorg" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
  });

  it("carries both fields on GET /api/runs/:id", async () => {
    const row = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      contextWindow: 200_000,
      compactionThreshold: 136_000,
    });

    const res = await app.request(`/api/runs/${row.id}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const wire = (await res.json()) as ContextBudgetWire;
    expect(wire.context_window).toBe(200_000);
    expect(wire.compaction_threshold).toBe(136_000);
  });

  it("carries both fields on the list read path", async () => {
    await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      contextWindow: 128_000,
      compactionThreshold: 102_400,
    });

    const res = await app.request("/api/runs", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: ContextBudgetWire[] };
    expect(body.data[0]!.context_window).toBe(128_000);
    expect(body.data[0]!.compaction_threshold).toBe(102_400);
  });

  // Serialization-only: this seeds the columns unset and asserts the SHAPE the
  // SPA receives. It says nothing about which creation paths leave them unset —
  // that is what "run context budget — write path" below covers, by launching
  // real runs. Kept separate because the failure modes differ: a serializer that
  // drops an unset column (making it `undefined` on the wire) or coerces it to 0
  // would break the gauge just as badly as a wrong write, and neither read path
  // above would notice.
  it("serialises unset columns as explicit JSON null, never 0 or absent", async () => {
    const row = await seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      runOrigin: "remote",
    });

    const res = await app.request(`/api/runs/${row.id}`, { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const wire = (await res.json()) as ContextBudgetWire;
    // `toBeNull` alone would pass on a key that is present-and-null OR absent
    // in a loosely typed read; assert presence explicitly first.
    expect(Object.keys(wire)).toContain("context_window");
    expect(Object.keys(wire)).toContain("compaction_threshold");
    expect(wire.context_window).toBeNull();
    expect(wire.compaction_threshold).toBeNull();
  });
});

describe("run context budget — DB invariants", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "ctxorg" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  function seedBudget(contextWindow: number | null, compactionThreshold: number | null) {
    return seedRun({
      packageId: AGENT,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      contextWindow,
      compactionThreshold,
    });
  }

  it("rejects a non-positive context_window", async () => {
    await expect(seedBudget(0, null)).rejects.toThrow();
    await expect(seedBudget(-1, null)).rejects.toThrow();
  });

  it("rejects a compaction_threshold at or above the window", async () => {
    await expect(seedBudget(200_000, 200_000)).rejects.toThrow();
    await expect(seedBudget(200_000, 200_001)).rejects.toThrow();
  });

  it("rejects a non-positive compaction_threshold", async () => {
    await expect(seedBudget(200_000, 0)).rejects.toThrow();
    await expect(seedBudget(200_000, -1)).rejects.toThrow();
  });

  it("rejects an orphan threshold with no window to divide by", async () => {
    // The bare `compaction_threshold < context_window` comparison evaluates to
    // NULL here, and a CHECK accepts NULL — so this row WAS legal until the
    // constraint was written as an explicit `IS NULL OR (…)`. The two columns
    // are meaningless apart: a threshold with no window is a number the gauge
    // cannot use.
    await expect(seedBudget(null, 42)).rejects.toThrow();
  });

  it("accepts a window with no threshold (window resolved, no usable cap)", async () => {
    const row = await seedBudget(200_000, null);
    expect(row.contextWindow).toBe(200_000);
    expect(row.compactionThreshold).toBeNull();
  });

  it("accepts both NULL (unknown budget) and a valid pair", async () => {
    // Positive control: without it, a constraint typo that rejects EVERY row
    // would make all the rejection cases above pass while the feature is dead.
    const unknown = await seedBudget(null, null);
    expect(unknown.contextWindow).toBeNull();
    expect(unknown.compactionThreshold).toBeNull();

    const known = await seedBudget(200_000, 160_000);
    expect(known.contextWindow).toBe(200_000);
    expect(known.compactionThreshold).toBe(160_000);

    // And the boundary that must stay legal: threshold one token below the
    // window.
    const boundary = await seedBudget(200_000, 199_999);
    expect(boundary.compactionThreshold).toBe(199_999);
  });
});

/**
 * The WRITE path — `prepareAndExecuteRun` → `deriveRunContextBudget` →
 * `createRun`, driven end to end through `POST /api/agents/:scope/:name/run`.
 *
 * Nothing above this block exercises it: the read/serialization tests seed the
 * columns directly and the DB-invariant tests bypass the service layer, so
 * deleting the two `contextWindow` / `compactionThreshold` lines from
 * `run-pipeline.ts` left the whole suite green. What is pinned here is which
 * values actually reach the row for a real launch — in particular the case that
 * must NOT be a number.
 *
 * Fire-and-forget execution runs against a fake orchestrator (no Docker) so it
 * settles in-process instead of a real image pull racing the next
 * `truncateAll()`. Same pattern, same reason, as `routes/runs.test.ts`.
 */
describe("run context budget — write path (prepareAndExecuteRun)", () => {
  let ctx: TestContext;

  const RUNNABLE = "@ctxorg/budget-agent";

  /** Minimal no-op orchestrator: workloads "run" instantly and exit 0. */
  function createFakeOrchestrator(): RunOrchestrator {
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
      async stopByRunId(): Promise<StopResult> {
        return "stopped";
      },
      async resolvePlatformApiUrl(): Promise<string> {
        return "http://platform:3000";
      },
    };
  }

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    // Drain FIRST, truncate SECOND. `truncateAll()` is a `DELETE FROM` sweep
    // over every table; a background run still writing `runs`/`run_logs` holds
    // FK row locks on `packages`/`organizations` that the sweep wants to
    // delete, and Postgres breaks the resulting cycle with a 40P01 deadlock.
    // Draining here as WELL as in `afterEach` is deliberate belt-and-braces:
    // `afterEach` is the primary net (it runs even when the test body threw
    // before its last line), but bun aborts a hook that exceeds the per-test
    // timeout, and an aborted `afterEach` would otherwise hand a live run to
    // this sweep. A no-op when the drain already happened.
    await drainLaunchedRuns();
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "ctxorg" });
    await seedAgent({
      id: RUNNABLE,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: RUNNABLE,
        version: "0.1.0",
        type: "agent",
        description: "Agent used to exercise the persisted context budget",
      },
      draftContent: "Do the thing.",
    });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, RUNNABLE);
  });

  // Primary drain. Unlike a trailing `await settle()` on the last line of each
  // test, this runs whether the test passed, failed an assertion, or threw —
  // so a single red test can no longer hand its still-writing background run
  // to the next test's `truncateAll()` and cascade the whole file into
  // deadlocks.
  afterEach(async () => {
    await drainLaunchedRuns();
  });

  /**
   * Seed an org model and make it the org default.
   *
   * `modelId` decides whether the vendored catalog supplies a context window:
   * a real catalog entry does, an unknown id does not (the `org_models` row's
   * own nullable column is the only other source — `resolveModelMetadata`'s
   * `src.contextWindow ?? defaults.contextWindow ?? null` cascade).
   */
  async function useOrgModel(
    label: string,
    modelId: string,
    capabilities?: { contextWindow?: number; maxTokens?: number },
  ): Promise<void> {
    const credentialId = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: `${label} credential`,
      providerId: "openai-compatible",
      apiKey: "sk-test-not-a-real-key",
      baseUrlOverride: "https://llm.example.com/v1",
    });
    const modelDbId = await createOrgModel(
      ctx.orgId,
      label,
      modelId,
      ctx.user.id,
      credentialId,
      capabilities,
    );
    await setDefaultModel(ctx.orgId, modelDbId);
  }

  /**
   * Run ids launched by the CURRENT test, awaiting drain.
   *
   * Scoped to the describe (not the test body) so `afterEach` can drain a run
   * whose test threw before reaching its own last line — the exact case the
   * old trailing `await settle()` silently skipped.
   */
  const launchedRunIds: string[] = [];

  async function trigger(): Promise<string> {
    const res = await app.request(`/api/agents/${RUNNABLE}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    // Recorded BEFORE any caller assertion can throw. `prepareAndExecuteRun`
    // calls `trackRun()` synchronously (the `runWithSpan` facade is a plain
    // `fn()` passthrough with no provider installed), so the run is already in
    // the in-flight map by the time this 201 is read.
    launchedRunIds.push(body.id);
    return body.id;
  }

  /**
   * How many `run_logs` rows the platform writes DETACHED (`void appendRunLog`)
   * on a launch: one in `run-pipeline.ts` ("run created - starting containers")
   * and one in `run-launcher/execute-background.ts` ("containers starting").
   * Both tag `data` with `{ platform: true }`; every other write on this path
   * is awaited inside `executeAgentInBackground`, so these two are the only DB
   * writes that can outlive the in-flight tracker.
   *
   * If the platform ever adds or drops a detached breadcrumb, the drain below
   * fails loudly with the count it saw rather than going quiet — which is the
   * point: a silent under-count is exactly what a `Bun.sleep(300)` used to
   * paper over.
   */
  const DETACHED_PLATFORM_BREADCRUMBS = 2;

  async function platformBreadcrumbCount(runId: string): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), sql`${runLogs.data}->>'platform' = 'true'`));
    return row?.n ?? 0;
  }

  /**
   * Fully quiesce every run this test launched, so no background DB write can
   * survive into the next test's `truncateAll()`.
   *
   * Two stages, because one is not enough:
   *
   *  1. `waitForInFlight` — `executeAgentInBackground` calls `untrackRun()` in
   *     its `finally`, so this covers the whole AWAITED chain (status flips,
   *     `synthesiseFinalize` -> `finalizeRun` -> terminal log + notification
   *     fan-out). Necessary, but NOT sufficient.
   *  2. The two DETACHED `void appendRunLog(...)` breadcrumbs, fired and
   *     forgotten, which can still be in flight after the tracker reports
   *     empty. This waits on the OBSERVABLE EFFECT — the rows being visible —
   *     not on elapsed time, so it is deterministic. The old `Bun.sleep(300)`
   *     was a bet that 300ms is always enough, and a loaded CI box is exactly
   *     where that bet loses.
   *
   * The `Bun.sleep(5)` below is a poll interval inside a condition loop, not a
   * fixed wait: it exits as soon as the predicate holds.
   */
  async function drainLaunchedRuns(): Promise<void> {
    const runIds = launchedRunIds.splice(0);
    if (runIds.length === 0) return;

    if (!(await waitForInFlight(10_000))) {
      throw new Error(`drain: run(s) still in flight after 10s: ${runIds.join(", ")}`);
    }

    const deadline = Date.now() + 10_000;
    for (const runId of runIds) {
      let seen = await platformBreadcrumbCount(runId);
      while (seen < DETACHED_PLATFORM_BREADCRUMBS) {
        if (Date.now() > deadline) {
          throw new Error(
            `drain: run ${runId} settled with ${seen}/${DETACHED_PLATFORM_BREADCRUMBS} ` +
              "detached platform breadcrumbs after 10s — the set of detached " +
              "run_logs writes in the run pipeline has changed; update " +
              "DETACHED_PLATFORM_BREADCRUMBS.",
          );
        }
        await Bun.sleep(5);
        seen = await platformBreadcrumbCount(runId);
      }
    }
  }

  async function persistedBudget(runId: string) {
    const [row] = await db
      .select({
        contextWindow: runs.contextWindow,
        compactionThreshold: runs.compactionThreshold,
      })
      .from(runs)
      .where(eq(runs.id, runId));
    return row!;
  }

  it("persists the declared window and the derived compaction threshold", async () => {
    await useOrgModel("Declared Window", "ctx-budget-declared", {
      contextWindow: 200_000,
      maxTokens: 64_000,
    });

    const runId = await trigger();
    // 64k is a usable cap (< window) → reserved verbatim → 200000 - 64000.
    expect(await persistedBudget(runId)).toEqual({
      contextWindow: 200_000,
      compactionThreshold: 136_000,
    });
  });

  // THE regression this suite exists for. `buildRuntimePiEnv` omits
  // `MODEL_CONTEXT_WINDOW` when the resolved model declares none, and the
  // container then applies its OWN 128 000 default — not core's 200 000. A
  // platform-side fallback of 200 000 would draw a gauge reading ~64 % at true
  // saturation, with a compaction line the run can never reach. Reachable for
  // any `org_models` row whose (providerId, modelId) misses the vendored
  // catalog: self-hosted and openai-compatible endpoints, newly released models.
  it("persists NULL — not a guessed window — when the model declares none", async () => {
    await useOrgModel("Undeclared Window", "ctx-budget-not-in-any-catalog-zzz");

    const runId = await trigger();
    const budget = await persistedBudget(runId);
    expect(budget.contextWindow).toBeNull();
    expect(budget.compactionThreshold).toBeNull();
    // Pin the specific wrong answers, so a reintroduced fallback fails loudly
    // rather than drifting past a bare null check.
    expect(budget.contextWindow).not.toBe(200_000);
    expect(budget.contextWindow).not.toBe(128_000);
  });

  // A window with no usable output cap still yields a budget — the derived 20 %
  // reserve. Guards against a fix that over-corrects into "NULL unless BOTH
  // fields are declared".
  it("persists a budget from a window alone, with no declared maxTokens", async () => {
    await useOrgModel("Window Only", "ctx-budget-window-only", { contextWindow: 32_768 });

    const runId = await trigger();
    // max(16384, floor(32768 × 0.2) = 6553) = 16384 reserve.
    expect(await persistedBudget(runId)).toEqual({
      contextWindow: 32_768,
      compactionThreshold: 32_768 - 16_384,
    });
  });
});
