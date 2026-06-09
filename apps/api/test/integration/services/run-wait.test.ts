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
