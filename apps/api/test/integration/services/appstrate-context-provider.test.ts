// SPDX-License-Identifier: Apache-2.0

/**
 * AppstrateContextProvider — verifies the DB-backed pull-side adapter
 * honours the runtime's ContextProvider contract: correct scoping,
 * createdAt-ms normalisation, limit/since semantics, actor filtering,
 * and excludeRunId for history.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedApplication } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { addPackageMemories } from "../../../src/services/state/package-memories.ts";
import { AppstrateContextProvider } from "../../../src/services/adapters/appstrate-context-provider.ts";
import type { Actor } from "../../../src/lib/actor.ts";

describe("AppstrateContextProvider", () => {
  let ctx: TestContext;
  const agentId = "@testorg/ctx-agent";
  let actor: Actor;

  /**
   * Seeds a success run (optionally against a non-default application).
   * Returns the created run id — `package_memories.run_id` is a NOT NULL
   * FK, so any test writing memories needs a real run to attach them to.
   * Intentionally NOT called in beforeEach: getHistory tests would see
   * it as an extra entry.
   */
  async function seedMemoryRun(opts?: { applicationId?: string }): Promise<string> {
    const run = await seedRun({
      packageId: agentId,
      orgId: ctx.orgId,
      applicationId: opts?.applicationId ?? ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      status: "success",
    });
    return run.id;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    actor = { type: "member", id: ctx.user.id };
    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, agentId);
  });

  describe("getMemories", () => {
    it("returns memories most-recent-first as epoch ms", async () => {
      const seedRunId = await seedMemoryRun();
      await addPackageMemories(
        agentId,
        ctx.orgId,
        ctx.defaultAppId,
        ["first", "second", "third"],
        seedRunId,
      );

      const provider = new AppstrateContextProvider({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        packageId: agentId,
        actor,
      });

      const memories = await provider.getMemories();
      expect(memories).toHaveLength(3);
      // Most recent first: addPackageMemories inserts in array order, so
      // "third" was inserted last and should appear first after reversal.
      expect(memories.map((m) => m.content)).toEqual(["third", "second", "first"]);
      // createdAt must be a finite number (epoch ms).
      for (const m of memories) {
        expect(typeof m.createdAt).toBe("number");
        expect(Number.isFinite(m.createdAt)).toBe(true);
      }
    });

    it("respects limit", async () => {
      const seedRunId = await seedMemoryRun();
      await addPackageMemories(
        agentId,
        ctx.orgId,
        ctx.defaultAppId,
        ["a", "b", "c", "d"],
        seedRunId,
      );

      const provider = new AppstrateContextProvider({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        packageId: agentId,
        actor,
      });

      const memories = await provider.getMemories({ limit: 2 });
      expect(memories).toHaveLength(2);
    });

    it("respects `since` threshold", async () => {
      const seedRunId = await seedMemoryRun();
      await addPackageMemories(agentId, ctx.orgId, ctx.defaultAppId, ["old"], seedRunId);
      const cutoff = Date.now() + 100; // future → nothing passes
      const provider = new AppstrateContextProvider({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        packageId: agentId,
        actor,
      });
      const memories = await provider.getMemories({ since: cutoff });
      expect(memories).toHaveLength(0);
    });

    it("scopes memories by applicationId", async () => {
      const appB = await seedApplication({ orgId: ctx.orgId, name: "AppB" });
      await installPackage({ orgId: ctx.orgId, applicationId: appB.id }, agentId);
      const appARunId = await seedMemoryRun();
      const appBRunId = await seedMemoryRun({ applicationId: appB.id });

      await addPackageMemories(agentId, ctx.orgId, ctx.defaultAppId, ["appA-mem"], appARunId);
      await addPackageMemories(agentId, ctx.orgId, appB.id, ["appB-mem"], appBRunId);

      const provider = new AppstrateContextProvider({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        packageId: agentId,
        actor,
      });

      const memories = await provider.getMemories();
      expect(memories.map((m) => m.content)).toEqual(["appA-mem"]);
    });
  });

  describe("getState", () => {
    it("returns the most recent run's state", async () => {
      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
        state: { counter: 1 },
        startedAt: new Date("2025-01-01"),
      });
      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
        state: { counter: 2 },
        startedAt: new Date("2025-01-02"),
      });

      const provider = new AppstrateContextProvider({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        packageId: agentId,
        actor,
      });

      const state = await provider.getState();
      expect(state).toEqual({ counter: 2 });
    });

    it("returns null when no state exists", async () => {
      const provider = new AppstrateContextProvider({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        packageId: agentId,
        actor,
      });
      expect(await provider.getState()).toBeNull();
    });
  });

  describe("getHistory", () => {
    it("returns recent successful runs with runId + epoch-ms timestamp", async () => {
      const run1 = await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
        state: { step: 1 },
        startedAt: new Date("2025-01-01T00:00:00Z"),
      });
      const run2 = await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
        state: { step: 2 },
        startedAt: new Date("2025-01-02T00:00:00Z"),
      });

      const provider = new AppstrateContextProvider({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        packageId: agentId,
        actor,
      });

      const history = await provider.getHistory();
      expect(history.map((h) => h.runId)).toEqual([run2.id, run1.id]);
      for (const h of history) {
        expect(typeof h.timestamp).toBe("number");
        expect(Number.isFinite(h.timestamp)).toBe(true);
      }
    });

    it("honours excludeRunId scoping", async () => {
      const target = await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
        startedAt: new Date("2025-01-05"),
      });
      await seedRun({
        packageId: agentId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
        startedAt: new Date("2025-01-04"),
      });

      const provider = new AppstrateContextProvider({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        packageId: agentId,
        actor,
        excludeRunId: target.id,
      });

      const history = await provider.getHistory();
      expect(history.some((h) => h.runId === target.id)).toBe(false);
      expect(history).toHaveLength(1);
    });

    it("respects limit", async () => {
      for (let i = 0; i < 5; i++) {
        await seedRun({
          packageId: agentId,
          orgId: ctx.orgId,
          applicationId: ctx.defaultAppId,
          dashboardUserId: ctx.user.id,
          status: "success",
          startedAt: new Date(2025, 0, i + 1),
        });
      }

      const provider = new AppstrateContextProvider({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        packageId: agentId,
        actor,
      });
      const history = await provider.getHistory({ limit: 2 });
      expect(history).toHaveLength(2);
    });
  });
});
