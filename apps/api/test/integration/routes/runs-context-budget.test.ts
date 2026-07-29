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

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";

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

  it("reports NULL (not zero) for a run that resolved no platform model", async () => {
    // Remote-origin runs execute on the caller's host with the caller's own
    // model, so the platform has no window to record. NULL is the honest value —
    // a 0 would render as an empty context gauge, which is a lie.
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
