// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-app isolation tests for run state functions.
 *
 * Verifies that getLastCheckpoint, getRecentRuns, getRunningRunCounts,
 * and deletePackageRuns properly scope to applicationId.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedApplication } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import {
  getLastCheckpoint,
  getRecentRuns,
  getRunningRunCounts,
  deletePackageRuns,
} from "../../../src/services/state/runs.ts";

describe("Cross-app run isolation (service layer)", () => {
  let ctx: TestContext;
  let appBId: string;
  const agentId = "@testorg/iso-agent";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    const appB = await seedApplication({ orgId: ctx.orgId, name: "AppB" });
    appBId = appB.id;

    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, agentId);
    await installPackage({ orgId: ctx.orgId, applicationId: appBId }, agentId);
  });

  describe("getLastCheckpoint", () => {
    it("returns state only from the requested application", async () => {
      // Seed a run with state in AppA
      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
        checkpoint: { source: "appA" },
        startedAt: new Date("2025-01-01"),
      });

      // Seed a more recent run with state in AppB
      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: appBId,
        userId: ctx.user.id,
        status: "success",
        checkpoint: { source: "appB" },
        startedAt: new Date("2025-01-02"),
      });

      // AppA should get its own state, not AppB's (even though AppB's is more recent)
      const stateA = await getLastCheckpoint(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        agentId,
        null,
      );
      expect(stateA).toEqual({ source: "appA" });

      const stateB = await getLastCheckpoint(
        { orgId: ctx.orgId, applicationId: appBId },
        agentId,
        null,
      );
      expect(stateB).toEqual({ source: "appB" });
    });

    it("returns null when no runs exist in the requested application", async () => {
      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: appBId,
        userId: ctx.user.id,
        status: "success",
        checkpoint: { source: "appB" },
      });

      const state = await getLastCheckpoint(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        agentId,
        null,
      );
      expect(state).toBeNull();
    });
  });

  describe("getRecentRuns", () => {
    it("returns runs only from the requested application", async () => {
      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
        startedAt: new Date("2025-01-01"),
      });

      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: appBId,
        userId: ctx.user.id,
        status: "success",
        startedAt: new Date("2025-01-02"),
      });

      const runsA = await getRecentRuns(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        agentId,
        null,
      );
      expect(runsA).toHaveLength(1);

      const runsB = await getRecentRuns({ orgId: ctx.orgId, applicationId: appBId }, agentId, null);
      expect(runsB).toHaveLength(1);
    });
  });

  describe("getRunningRunCounts", () => {
    it("counts running runs only in the requested application", async () => {
      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });

      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: appBId,
        userId: ctx.user.id,
        status: "running",
      });

      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: appBId,
        userId: ctx.user.id,
        status: "running",
      });

      const countsA = await getRunningRunCounts({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
      });
      expect(countsA[agentId]).toBe(1);

      const countsB = await getRunningRunCounts({ orgId: ctx.orgId, applicationId: appBId });
      expect(countsB[agentId]).toBe(2);
    });
  });

  describe("deletePackageRuns", () => {
    it("deletes runs only in the requested application", async () => {
      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: appBId,
        userId: ctx.user.id,
        status: "success",
      });

      const deleted = await deletePackageRuns(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        agentId,
      );
      expect(deleted).toBe(1);

      // AppB run should survive
      const runsB = await getRecentRuns({ orgId: ctx.orgId, applicationId: appBId }, agentId, null);
      expect(runsB).toHaveLength(1);
    });
  });
});
