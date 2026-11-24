// SPDX-License-Identifier: Apache-2.0

/**
 * `createRun`'s in-transaction per-org concurrency reservation.
 *
 * This is the AUTHORITATIVE enforcement of `max_concurrent_per_org`: the
 * preflight gate (`run-preflight-gates.ts`) documents its own count as a
 * non-atomic fast pre-check, because ~1.75s of pipeline work separates it from
 * the INSERT. The reservation re-counts and inserts under one per-org advisory
 * lock, so the cap holds exactly.
 *
 * It used to read the limits registry inside `try { … } catch { return; }`,
 * which turned ANY throw from that read into a silently uncapped INSERT — a
 * fail-OPEN gate. The peer read in `run-preflight-gates.ts` has always let the
 * identical throw propagate, so the "isolated unit test that never booted the
 * registry" rationale never covered a pipeline path: a caller reaching either
 * without `initRunLimits()` has a boot-ordering bug, not a run to admit.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";
import { runs } from "@appstrate/db/schema";
import { createRun } from "../../../src/services/state/runs.ts";
import {
  initRunLimits,
  _resetRunLimitsForTesting,
  _setRunLimitsForTesting,
} from "../../../src/services/run-limits.ts";

const PACKAGE_ID = "@capruns/agent";

describe("createRun — per-org concurrency reservation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "capruns" });
    await seedPackage({ id: PACKAGE_ID, orgId: ctx.orgId });
    // Every test starts from a booted registry; the fail-open test resets it
    // explicitly. This file is the only place the registry is torn down, and
    // it is restored in afterAll for the rest of the process.
    _setRunLimitsForTesting({ max_concurrent_per_org: 1 });
  });

  afterAll(() => {
    initRunLimits();
  });

  function scope() {
    return { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
  }

  function admit(id: string) {
    return createRun(scope(), {
      id,
      packageId: PACKAGE_ID,
      actor: null,
      input: null,
      modelId: null,
      inferenceRoute: null,
    });
  }

  async function runCount(): Promise<number> {
    const rows = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ctx.orgId));
    return rows.length;
  }

  // CONTROL. Passes before and after: with the registry booted and the org
  // below its cap, the reservation admits. Without it, a gate that rejected
  // (or threw) unconditionally would look identical to the two tests below.
  it("admits a run while the org is below its cap", async () => {
    await admit("run_under_cap");
    expect(await runCount()).toBe(1);
  });

  it("refuses the INSERT when the org is already at its cap", async () => {
    await seedRun({
      packageId: PACKAGE_ID,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
    });

    const err = await admit("run_at_cap").then(
      () => null,
      (e: unknown) => e,
    );

    expect((err as { code?: string } | null)?.code).toBe("org_run_concurrency_exceeded");
    // The seeded run is the only row — the transaction rolled back.
    expect(await runCount()).toBe(1);
  });

  it("propagates the uninitialised-registry throw instead of admitting the run", async () => {
    _resetRunLimitsForTesting();

    const err = await admit("run_no_limits").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not initialized/i);
    // The load-bearing half: the swallowed throw used to leave the cap
    // unenforced AND commit the row.
    expect(await runCount()).toBe(0);
  });

  // The cap a module (billing: the plan) sets for ONE org rides with the launch and is enforced
  // in the same transaction, under the same lock, as the deployment-wide one: a burst of
  // launches cannot overshoot it, which a count read before the INSERT could not guarantee.
  describe("an org cap set by a module", () => {
    function admitWithCap(id: string, maxConcurrentRuns: number | null) {
      return createRun(scope(), {
        id,
        packageId: PACKAGE_ID,
        actor: null,
        input: null,
        modelId: null,
        inferenceRoute: null,
        maxConcurrentRuns,
      });
    }

    it("admits exactly the cap out of ten parallel launches", async () => {
      _setRunLimitsForTesting({ max_concurrent_per_org: 50 });

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => admitWithCap(`run_burst_${i}`, 3)),
      );

      const admitted = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(admitted).toHaveLength(3);
      expect(refused).toHaveLength(7);
      for (const r of refused) {
        expect((r.reason as { code?: string }).code).toBe("org_run_concurrency_exceeded");
        expect((r.reason as { status?: number }).status).toBe(429);
      }
      expect(await runCount()).toBe(3);
    });

    it("applies the lower of the org cap and the deployment-wide cap", async () => {
      _setRunLimitsForTesting({ max_concurrent_per_org: 2 });

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) => admitWithCap(`run_lower_${i}`, 10)),
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect(await runCount()).toBe(2);
    });

    it("leaves the deployment-wide cap alone when the org has none", async () => {
      _setRunLimitsForTesting({ max_concurrent_per_org: 4 });

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => admitWithCap(`run_nocap_${i}`, null)),
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
    });
  });
});
