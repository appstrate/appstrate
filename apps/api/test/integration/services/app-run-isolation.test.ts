// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-app isolation tests for run state functions.
 *
 * Verifies that getRecentRuns, getRunningRunCounts, and deletePackageRuns
 * properly scope to applicationId.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedApplication } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import {
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
