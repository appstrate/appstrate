// SPDX-License-Identifier: Apache-2.0

/**
 * Service-level tests for `waitForRunTerminal` (issue #631) — the pieces
 * the HTTP-level tests can't reach directly: the fallback DB poll cadence
 * (Tier-0 / lost-NOTIFY degradation), the abort signal, and the
 * subscribe-after-read race on an already-terminal run.
 *
 * These tests deliberately do NOT call `initRealtime()`: when this file
 * runs standalone the realtime fan-out is absent and the fallback poll is
 * the only wakeup, proving the mechanism works without LISTEN/NOTIFY
 * delivery. (In a full-suite run another file may have initialized
 * realtime in the shared process — the assertions hold either way.)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import {
  waitForRunTerminal,
  parseWaitQuery,
  MAX_WAIT_SECONDS,
  MAX_CONCURRENT_WAITERS_PER_IDENTITY,
  activeWaiterCount,
  activePollLoopCount,
} from "../../../src/services/run-wait.ts";

describe("waitForRunTerminal", () => {
  let ctx: TestContext;
  let scope: { orgId: string; applicationId: string };

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "waitsvc" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    await seedAgent({ id: "@waitsvc/agent", orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  function seedSvcRun(status: "running" | "success") {
    return seedRun({
      packageId: "@waitsvc/agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status,
    });
  }

  it("resolves via the fallback DB poll when the run transitions", async () => {
    const run = await seedSvcRun("running");

    const start = Date.now();
    const waitPromise = waitForRunTerminal({
      runId: run.id,
      scope,
      timeoutMs: 10_000,
      pollIntervalMs: 50,
    });

    await Bun.sleep(150);
    await db.update(runs).set({ status: "success" }).where(eq(runs.id, run.id));

    await waitPromise;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("resolves immediately for an already-terminal run (subscribe-then-check race)", async () => {
    const run = await seedSvcRun("success");

    const start = Date.now();
    await waitForRunTerminal({ runId: run.id, scope, timeoutMs: 10_000, pollIntervalMs: 5_000 });
    // Resolved by the immediate post-subscribe re-check, not poll/timeout.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("resolves when the abort signal fires (client disconnect)", async () => {
    const run = await seedSvcRun("running");
    const controller = new AbortController();

    const start = Date.now();
    const waitPromise = waitForRunTerminal({
      runId: run.id,
      scope,
      timeoutMs: 30_000,
      pollIntervalMs: 5_000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 100);
    await waitPromise;
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("returns synchronously when the signal is already aborted", async () => {
    const run = await seedSvcRun("running");
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    await waitForRunTerminal({
      runId: run.id,
      scope,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("resolves on timeout when the run never transitions", async () => {
    const run = await seedSvcRun("running");

    const start = Date.now();
    await waitForRunTerminal({ runId: run.id, scope, timeoutMs: 300, pollIntervalMs: 5_000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("resolves promptly when the run does not exist (deleted mid-flight)", async () => {
    const start = Date.now();
    await waitForRunTerminal({
      runId: "run_gone",
      scope,
      timeoutMs: 10_000,
      pollIntervalMs: 5_000,
    });
    // The immediate re-check treats "row missing" as terminal.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  // ─── Per-identity concurrent-waiter cap ─────────────────────

  it("caps concurrent waiters per identity — excess waits degrade to no-wait", async () => {
    const run = await seedSvcRun("running");
    const controller = new AbortController();
    const identity = "user_cap_test";

    // Saturate the identity's slots. The slot is claimed synchronously on
    // call, before any awaiting starts.
    const held = Array.from({ length: MAX_CONCURRENT_WAITERS_PER_IDENTITY }, () =>
      waitForRunTerminal({
        runId: run.id,
        scope,
        timeoutMs: 30_000,
        pollIntervalMs: 5_000,
        identity,
        signal: controller.signal,
      }),
    );
    expect(activeWaiterCount(identity)).toBe(MAX_CONCURRENT_WAITERS_PER_IDENTITY);

    // One past the cap → resolves immediately (degrade-to-no-wait, not 429).
    const start = Date.now();
    await waitForRunTerminal({
      runId: run.id,
      scope,
      timeoutMs: 30_000,
      pollIntervalMs: 5_000,
      identity,
    });
    expect(Date.now() - start).toBeLessThan(500);
    // The degraded call did not consume (or leak) a slot.
    expect(activeWaiterCount(identity)).toBe(MAX_CONCURRENT_WAITERS_PER_IDENTITY);

    // A different identity is unaffected by the saturated one.
    const otherController = new AbortController();
    const other = waitForRunTerminal({
      runId: run.id,
      scope,
      timeoutMs: 30_000,
      pollIntervalMs: 5_000,
      identity: "user_cap_other",
      signal: otherController.signal,
    });
    expect(activeWaiterCount("user_cap_other")).toBe(1);

    // Releasing the held waits frees every slot (no leaks).
    controller.abort();
    otherController.abort();
    await Promise.all([...held, other]);
    expect(activeWaiterCount(identity)).toBe(0);
    expect(activeWaiterCount("user_cap_other")).toBe(0);
  });

  it("waits without an identity are not capped (internal callers)", async () => {
    const run = await seedSvcRun("success");
    // No identity → resolves via the immediate terminal re-check; the
    // waiter-count map is untouched.
    await waitForRunTerminal({ runId: run.id, scope, timeoutMs: 10_000, pollIntervalMs: 5_000 });
    expect(activeWaiterCount("")).toBe(0);
  });

  // ─── Shared per-run DB poll loop ────────────────────────────

  it("shares ONE DB poll loop per runId across concurrent waiters and tears it down", async () => {
    const run = await seedSvcRun("running");

    const waiters = Array.from({ length: 5 }, () =>
      waitForRunTerminal({ runId: run.id, scope, timeoutMs: 10_000, pollIntervalMs: 50 }),
    );
    // Five concurrent waiters on the same run → exactly one poll loop.
    expect(activePollLoopCount()).toBe(1);

    await Bun.sleep(100);
    await db.update(runs).set({ status: "success" }).where(eq(runs.id, run.id));

    // The single shared poll (or the NOTIFY fan-out when realtime is live in
    // this process) observes the transition and wakes EVERY waiter.
    await Promise.all(waiters);
    // Last waiter detached → the shared loop is gone.
    expect(activePollLoopCount()).toBe(0);
  });

  it("keeps poll loops independent across different runs", async () => {
    const runA = await seedSvcRun("running");
    const runB = await seedSvcRun("running");
    const controller = new AbortController();

    const waits = [
      waitForRunTerminal({
        runId: runA.id,
        scope,
        timeoutMs: 10_000,
        pollIntervalMs: 5_000,
        signal: controller.signal,
      }),
      waitForRunTerminal({
        runId: runB.id,
        scope,
        timeoutMs: 10_000,
        pollIntervalMs: 5_000,
        signal: controller.signal,
      }),
    ];
    expect(activePollLoopCount()).toBe(2);

    controller.abort();
    await Promise.all(waits);
    expect(activePollLoopCount()).toBe(0);
  });
});

describe("parseWaitQuery", () => {
  it("maps absent / false / 0 to no wait", () => {
    expect(parseWaitQuery(undefined)).toBe(0);
    expect(parseWaitQuery("false")).toBe(0);
    expect(parseWaitQuery("0")).toBe(0);
  });

  it("maps true and bare ?wait to the cap", () => {
    expect(parseWaitQuery("true")).toBe(MAX_WAIT_SECONDS * 1000);
    expect(parseWaitQuery("")).toBe(MAX_WAIT_SECONDS * 1000);
  });

  it("accepts integer seconds and clamps above the cap", () => {
    expect(parseWaitQuery("10")).toBe(10_000);
    expect(parseWaitQuery(String(MAX_WAIT_SECONDS))).toBe(MAX_WAIT_SECONDS * 1000);
    expect(parseWaitQuery("9999")).toBe(MAX_WAIT_SECONDS * 1000);
  });

  it("rejects negative, fractional, and non-numeric values", () => {
    for (const bad of ["-1", "1.5", "abc", "NaN", "Infinity"]) {
      expect(() => parseWaitQuery(bad)).toThrow();
    }
  });
});
