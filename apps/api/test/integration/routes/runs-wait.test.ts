// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/runs/:id?wait=…` long-poll (issue #631).
 *
 * Covers: wait-param validation, immediate return when the run is already
 * terminal, wait-then-return when the run transitions mid-poll, and the
 * timeout path (non-terminal response = "poll again").
 *
 * The transition test exercises whichever wakeup path is live in this
 * process: the `run_update` PG NOTIFY fan-out when `initRealtime()` ran
 * (we call it explicitly, mirroring realtime-sse.test.ts), with the 2 s
 * fallback DB poll as a backstop — both complete well inside the asserted
 * bound.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { initRealtime } from "../../../src/services/realtime.ts";

const app = getTestApp();

describe("GET /api/runs/:id?wait — long-poll", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await initRealtime();
    ctx = await createTestContext({ orgSlug: "waitorg" });
    await seedAgent({ id: "@waitorg/wait-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
  });

  function seedWaitRun(status: "pending" | "running" | "success" | "failed") {
    return seedRun({
      packageId: "@waitorg/wait-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status,
    });
  }

  // ─── Param validation ──────────────────────────────────────

  it.each(["abc", "-1", "1.5", "[]"])("returns 400 for wait=%s", async (value) => {
    const run = await seedWaitRun("success");

    const res = await app.request(`/api/runs/${run.id}?wait=${encodeURIComponent(value)}`, {
      headers: authHeaders(ctx),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.detail).toContain("wait");
  });

  it("validates the wait param even for an unreadable run (400 before 404)", async () => {
    const res = await app.request("/api/runs/run_nonexistent?wait=-5", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(400);
  });

  // ─── Immediate return ──────────────────────────────────────

  it("returns immediately when the run is already terminal", async () => {
    const run = await seedWaitRun("success");

    const start = Date.now();
    const res = await app.request(`/api/runs/${run.id}?wait=30`, {
      headers: authHeaders(ctx),
    });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(run.id);
    expect(body.status).toBe("success");
    // No 30 s hold — terminal short-circuits before any waiting starts.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("accepts wait=true (default cap) and wait above the cap (clamped)", async () => {
    const run = await seedWaitRun("failed");

    for (const wait of ["true", "9999"]) {
      const res = await app.request(`/api/runs/${run.id}?wait=${wait}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("failed");
    }
  });

  it("treats wait=0 and wait=false as no-wait on a non-terminal run", async () => {
    const run = await seedWaitRun("running");

    for (const wait of ["0", "false"]) {
      const start = Date.now();
      const res = await app.request(`/api/runs/${run.id}?wait=${wait}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("running");
      expect(Date.now() - start).toBeLessThan(1_000);
    }
  });

  // ─── Wait-then-return on transition ────────────────────────

  it("holds a non-terminal run and returns once it transitions to terminal", async () => {
    const run = await seedWaitRun("running");

    const start = Date.now();
    const resPromise = app.request(`/api/runs/${run.id}?wait=30`, {
      headers: authHeaders(ctx),
    });

    // Flip the run to terminal while the long poll is in flight. The
    // UPDATE fires the runs_notify_trigger → run_update NOTIFY → wait
    // resolves (fallback: the 2 s DB re-check).
    await Bun.sleep(200);
    await db
      .update(runs)
      .set({ status: "success", completedAt: new Date() })
      .where(eq(runs.id, run.id));

    const res = await resPromise;
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(run.id);
    expect(body.status).toBe("success");
    // Returned on the transition, not the 30 s budget. Bound generous
    // enough for the 2 s fallback-poll path on slow CI.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  // ─── Timeout path ──────────────────────────────────────────

  it("returns the current (non-terminal) run when the wait elapses — caller polls again", async () => {
    const run = await seedWaitRun("running");

    const start = Date.now();
    const res = await app.request(`/api/runs/${run.id}?wait=1`, {
      headers: authHeaders(ctx),
    });
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(run.id);
    expect(body.status).toBe("running");
    // Held for roughly the requested budget, then answered normally.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  // ─── Auth unchanged ────────────────────────────────────────

  it("returns 401 without authentication regardless of wait", async () => {
    const res = await app.request("/api/runs/run_anything?wait=5");
    expect(res.status).toBe(401);
  });

  it("returns 404 for another org's run without waiting", async () => {
    const otherCtx = await createTestContext({ orgSlug: "waitother" });
    await seedAgent({ id: "@waitother/agent", orgId: otherCtx.orgId });
    const run = await seedRun({
      packageId: "@waitother/agent",
      orgId: otherCtx.orgId,
      applicationId: otherCtx.defaultAppId,
      userId: otherCtx.user.id,
      status: "running",
    });

    const start = Date.now();
    const res = await app.request(`/api/runs/${run.id}?wait=30`, {
      headers: authHeaders(ctx),
    });

    expect(res.status).toBe(404);
    // Ownership is checked BEFORE waiting — no 30 s hold on a 404.
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});
