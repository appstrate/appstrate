// SPDX-License-Identifier: Apache-2.0

/**
 * `deletePackageRuns` — the two obligations it shares with its siblings.
 *
 * It is the third run-deleting path (`deleteOrganization` and
 * `deleteSpace` are the others) and was the only one honouring neither:
 *
 *  1. **Admission serialization.** The 409 lived in the route
 *     (`DELETE /api/agents/:scope/:name/runs`) as a non-transactional count. A
 *     launch spends ~1.75s of pipeline work before `createRun` inserts, so a
 *     delete arriving in that window counted 0 running, the INSERT then
 *     committed and containers booted, and the transaction's own SELECT saw
 *     the row and deleted it. The container kept running with live credentials
 *     against a run id that no longer existed: every sink POST 404s, no
 *     terminal status, no `onRunStatusChange`, no notification.
 *     `deleteOrganization` closes exactly this window with
 *     `pg_advisory_xact_lock(orgRunConcurrencyLockKey(orgId))` + an
 *     in-transaction re-count; this path now does the same.
 *  2. **The storage outbox.** `deleteSpace` enqueues
 *     `runWorkspaceDeletionJobs` per run. This path never did, so the bundle
 *     and the input-file objects of every deleted run were left referenced by
 *     no surviving row — invisible to every sweep, forever.
 *
 * The 409 is asserted here rather than only through the route, because the
 * lock and the count are the guard; the route is just one caller of it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedRun } from "../../helpers/seed.ts";
import { runs, storageDeletionJobs } from "@appstrate/db/schema";
import { deletePackageRuns } from "../../../src/services/state/runs.ts";
import {
  RUN_WORKSPACE_BUCKET,
  runWorkspaceBundleKey,
  runWorkspaceManifestKey,
} from "../../../src/services/run-workspace-manifest.ts";

const PACKAGE_ID = "@delruns/agent";

describe("deletePackageRuns", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "delruns" });
    await seedPackage({ id: PACKAGE_ID, orgId: ctx.orgId });
  });

  function scope() {
    return { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
  }

  async function seed(status: "pending" | "running" | "success" | "failed"): Promise<string> {
    const run = await seedRun({
      packageId: PACKAGE_ID,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status,
    });
    return run.id;
  }

  async function deletionJobsFor(runId: string): Promise<{ storageKey: string; reason: string }[]> {
    return db
      .select({ storageKey: storageDeletionJobs.storageKey, reason: storageDeletionJobs.reason })
      .from(storageDeletionJobs)
      .where(
        inArray(storageDeletionJobs.storageKey, [
          runWorkspaceBundleKey(runId),
          runWorkspaceManifestKey(runId),
        ]),
      );
  }

  it("enqueues each deleted run's workspace objects into the deletion outbox", async () => {
    const runA = await seed("success");
    const runB = await seed("failed");

    expect(await deletePackageRuns(scope(), PACKAGE_ID)).toBe(2);

    for (const runId of [runA, runB]) {
      const jobs = await deletionJobsFor(runId);
      // Two bounded rows per run: the bundle, and the manifest the worker
      // expands into the run's input-file objects.
      expect(jobs.map((j) => j.storageKey).sort()).toEqual(
        [runWorkspaceBundleKey(runId), runWorkspaceManifestKey(runId)].sort(),
      );
      expect(new Set(jobs.map((j) => j.reason))).toEqual(new Set(["package_runs_deleted"]));
    }
    // Same bucket the sibling cascades enqueue against — a job in the wrong
    // bucket is a no-op the worker completes without deleting anything.
    const [sample] = await db
      .select({ bucket: storageDeletionJobs.bucket })
      .from(storageDeletionJobs)
      .limit(1);
    expect(sample!.bucket).toBe(RUN_WORKSPACE_BUCKET);
  });

  for (const status of ["pending", "running"] as const) {
    it(`refuses (409) while a ${status} run exists, and deletes nothing`, async () => {
      const active = await seed(status);
      const done = await seed("success");

      let code: string | undefined;
      let httpStatus: number | undefined;
      try {
        await deletePackageRuns(scope(), PACKAGE_ID);
        throw new Error("expected deletePackageRuns to throw");
      } catch (err) {
        code = (err as { code?: string }).code;
        httpStatus = (err as { status?: number }).status;
      }
      expect(httpStatus).toBe(409);
      expect(code).toBe("run_in_progress");

      // The transaction rolled back whole: the terminal sibling is untouched
      // too, and no workspace object was queued for deletion.
      const surviving = await db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.orgId, ctx.orgId));
      expect(surviving.map((r) => r.id).sort()).toEqual([active, done].sort());
      expect(await deletionJobsFor(done)).toHaveLength(0);
    });
  }

  it("deletes runs of the requested package only", async () => {
    const OTHER = "@delruns/other";
    await seedPackage({ id: OTHER, orgId: ctx.orgId });
    const mine = await seed("success");
    const other = await seedRun({
      packageId: OTHER,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
    });

    // A RUNNING run of another package is none of this delete's business — the
    // active-run guard is scoped to the package being emptied, exactly like the
    // route-level count it replaced.
    expect(await deletePackageRuns(scope(), PACKAGE_ID)).toBe(1);

    const surviving = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, ctx.orgId));
    expect(surviving.map((r) => r.id)).toEqual([other.id]);
    expect(await deletionJobsFor(mine)).toHaveLength(2);
  });
});
