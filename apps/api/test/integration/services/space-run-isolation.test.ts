// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-space isolation tests for run state functions.
 *
 * Verifies that getRecentRuns, getRunningRunCounts, and deletePackageRuns
 * properly scope to spaceId.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedSpace } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/space-packages.ts";
import {
  getRecentRuns,
  getRunningRunCounts,
  deletePackageRuns,
} from "../../../src/services/state/runs.ts";

describe("Cross-space run isolation (service layer)", () => {
  let ctx: TestContext;
  let spaceBId: string;
  const agentId = "@testorg/iso-agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    const spaceB = await seedSpace({ orgId: ctx.orgId, name: "SpaceB" });
    spaceBId = spaceB.id;

    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, agentId);
    await installPackage({ orgId: ctx.orgId, spaceId: spaceBId }, agentId);
  });

  describe("getRecentRuns", () => {
    it("returns runs only from the requested space", async () => {
      // Assert on the run IDS, not just the counts. One run per space means a
      // resolver that swapped the two scopes — or ignored `spaceId` and picked
      // one row by `started_at` — still answers "1" on both sides, so a length
      // check alone passes on the leak it is meant to catch.
      const runA = await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        status: "success",
        startedAt: new Date("2025-01-01"),
      });

      const runB = await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        spaceId: spaceBId,
        userId: ctx.user.id,
        status: "success",
        startedAt: new Date("2025-01-02"),
      });

      const runsA = await getRecentRuns(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        agentId,
        { type: "user", id: ctx.user.id },
      );
      expect(runsA.map((r) => r.id)).toEqual([runA.id]);

      const runsB = await getRecentRuns({ orgId: ctx.orgId, spaceId: spaceBId }, agentId, {
        type: "user",
        id: ctx.user.id,
      });
      expect(runsB.map((r) => r.id)).toEqual([runB.id]);
    });

    it("isolates the actor-less bucket from a user's runs", async () => {
      // A null actor is the SHARED bucket (user_id IS NULL AND end_user_id IS
      // NULL), never "any actor" — otherwise an actor-less run would read a
      // member's private result/checkpoint out of its own history.
      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        status: "success",
        startedAt: new Date("2025-01-01"),
      });

      const shared = await getRecentRuns(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        agentId,
        null,
      );
      expect(shared).toHaveLength(0);
    });
  });

  describe("getRunningRunCounts", () => {
    it("counts running runs only in the requested space", async () => {
      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        status: "running",
      });

      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        spaceId: spaceBId,
        userId: ctx.user.id,
        status: "running",
      });

      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        spaceId: spaceBId,
        userId: ctx.user.id,
        status: "running",
      });

      const countsA = await getRunningRunCounts({
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
      });
      expect(countsA[agentId]).toBe(1);

      const countsB = await getRunningRunCounts({ orgId: ctx.orgId, spaceId: spaceBId });
      expect(countsB[agentId]).toBe(2);
    });
  });

  describe("deletePackageRuns", () => {
    it("deletes runs only in the requested space", async () => {
      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        status: "success",
      });

      const runB = await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        spaceId: spaceBId,
        userId: ctx.user.id,
        status: "success",
      });

      const deleted = await deletePackageRuns(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        agentId,
      );
      expect(deleted).toBe(1);

      // Space B's run must survive, and it must be the one that survives —
      // deleting B's row instead of A's also leaves exactly one behind.
      const runsB = await getRecentRuns({ orgId: ctx.orgId, spaceId: spaceBId }, agentId, {
        type: "user",
        id: ctx.user.id,
      });
      expect(runsB.map((r) => r.id)).toEqual([runB.id]);
      const runsA = await getRecentRuns(
        { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        agentId,
        { type: "user", id: ctx.user.id },
      );
      expect(runsA).toHaveLength(0);
    });
  });
});
