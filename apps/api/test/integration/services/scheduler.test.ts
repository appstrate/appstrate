// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for scheduler CRUD functions.
 *
 * Uses real BullMQ + Redis (provided by test preload).
 * No mock.module on any src/ path.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";

// Catch stale fire-and-forget rejections from previous test cycles
// (e.g., ensureDefaultProfile racing with truncateAll)
process.on("unhandledRejection", () => {});
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedPackage, seedConnectionProfile, seedConnectionForApp } from "../../helpers/seed.ts";
import { flushRedis, closeRedis } from "../../helpers/redis.ts";
import { connectionProfiles, applicationProviderCredentials } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import {
  createSchedule,
  listSchedules,
  listPackageSchedules,
  getSchedule,
  updateSchedule,
  deleteSchedule,
} from "../../../src/services/scheduler.ts";

describe("scheduler service", () => {
  let userId: string;
  let orgId: string;
  let orgSlug: string;
  let defaultAppId: string;
  let packageId: string;
  let connectionProfileId: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org, defaultAppId: applicationId } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    orgSlug = org.slug;
    defaultAppId = applicationId;

    const profile = await seedConnectionProfile({ userId, name: "Default" });
    connectionProfileId = profile.id;

    // Seed an agent package that schedules will reference
    const pkg = await seedPackage({
      orgId,
      id: `@${orgSlug}/scheduled-agent`,
      draftManifest: {
        name: `@${orgSlug}/scheduled-agent`,
        version: "0.1.0",
        type: "agent",
        description: "An agent for schedule tests",
      },
    });
    packageId = pkg.id;
  });

  afterAll(async () => {
    await closeRedis();
  });

  // ── createSchedule ──────────────────────────────────────

  describe("createSchedule", () => {
    it("creates a record with correct fields", async () => {
      const schedule = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          name: "Every hour",
          cronExpression: "0 * * * *",
          timezone: "UTC",
        },
      );

      expect(schedule.id).toMatch(/^sched_/);
      expect(schedule.packageId).toBe(packageId);
      expect(schedule.orgId).toBe(orgId);
      expect(schedule.connectionProfileId).toBe(connectionProfileId);
      expect(schedule.cronExpression).toBe("0 * * * *");
      expect(schedule.timezone).toBe("UTC");
      expect(schedule.enabled).toBe(true);
      expect(schedule.name).toBe("Every hour");
      expect(schedule.nextRunAt).toBeInstanceOf(Date);
      expect(schedule.createdAt).toBeInstanceOf(Date);
    });

    it("stores JSON input when provided", async () => {
      const inputData = { query: "test search", limit: 10 };

      const schedule = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          cronExpression: "*/5 * * * *",
          input: inputData,
        },
      );

      expect(schedule.input).toEqual(inputData);
    });

    it("defaults timezone to UTC when not specified", async () => {
      const schedule = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          cronExpression: "0 9 * * *",
        },
      );

      expect(schedule.timezone).toBe("UTC");
    });

    it("computes nextRunAt in the future", async () => {
      const schedule = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          cronExpression: "0 * * * *",
          timezone: "UTC",
        },
      );

      expect(schedule.nextRunAt).not.toBeNull();
      expect(schedule.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it("persists per-schedule overrides verbatim", async () => {
      const schedule = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          cronExpression: "0 9 * * *",
          configOverride: { providers: { gmail: { scopes: ["read"] } } },
          modelIdOverride: "model_abc",
          proxyIdOverride: "prx_xyz",
          versionOverride: "1.2.3",
        },
      );

      expect(schedule.configOverride).toEqual({
        providers: { gmail: { scopes: ["read"] } },
      });
      expect(schedule.modelIdOverride).toBe("model_abc");
      expect(schedule.proxyIdOverride).toBe("prx_xyz");
      expect(schedule.versionOverride).toBe("1.2.3");
    });

    it("defaults all overrides to null when omitted", async () => {
      const schedule = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          cronExpression: "0 9 * * *",
        },
      );

      expect(schedule.configOverride).toBeNull();
      expect(schedule.modelIdOverride).toBeNull();
      expect(schedule.proxyIdOverride).toBeNull();
      expect(schedule.versionOverride).toBeNull();
    });
  });

  // ── listSchedules ───────────────────────────────────────

  describe("listSchedules", () => {
    it("returns schedules for the org", async () => {
      await createSchedule({ orgId: orgId, applicationId: defaultAppId }, packageId, connectionProfileId, {
        name: "Schedule A",
        cronExpression: "0 * * * *",
      });
      await createSchedule({ orgId: orgId, applicationId: defaultAppId }, packageId, connectionProfileId, {
        name: "Schedule B",
        cronExpression: "*/30 * * * *",
      });

      const schedules = await listSchedules({ orgId: orgId, applicationId: defaultAppId });

      expect(schedules).toHaveLength(2);
      const names = schedules.map((s) => s.name);
      expect(names).toContain("Schedule A");
      expect(names).toContain("Schedule B");
    });

    it("does not return schedules from other orgs", async () => {
      await createSchedule({ orgId: orgId, applicationId: defaultAppId }, packageId, connectionProfileId, {
        name: "My Schedule",
        cronExpression: "0 * * * *",
      });

      const otherUser = await createTestUser({ email: "other@test.com" });
      const { org: otherOrg, defaultAppId: otherDefaultAppId } = await createTestOrg(otherUser.id, {
        slug: "otherorg",
      });
      const otherPkg = await seedPackage({
        orgId: otherOrg.id,
        id: "@otherorg/other-agent",
        draftManifest: {
          name: "@otherorg/other-agent",
          version: "0.1.0",
          type: "agent",
          description: "Other",
        },
      });
      const otherProfile = await seedConnectionProfile({ userId: otherUser.id, name: "Default" });
      await createSchedule(
        { orgId: otherOrg.id, applicationId: otherDefaultAppId },
        otherPkg.id,
        otherProfile.id,
        {
          name: "Other Schedule",
          cronExpression: "0 * * * *",
        },
      );

      const schedules = await listSchedules({ orgId: orgId, applicationId: defaultAppId });
      expect(schedules).toHaveLength(1);
      expect(schedules[0]!.name).toBe("My Schedule");

      const otherSchedules = await listSchedules({
        orgId: otherOrg.id,
        applicationId: otherDefaultAppId,
      });
      expect(otherSchedules).toHaveLength(1);
      expect(otherSchedules[0]!.name).toBe("Other Schedule");
    });

    it("returns an empty array when no schedules exist", async () => {
      const schedules = await listSchedules({ orgId: orgId, applicationId: defaultAppId });
      expect(schedules).toBeArray();
      expect(schedules).toHaveLength(0);
    });
  });

  // ── listPackageSchedules ────────────────────────────────

  describe("listPackageSchedules", () => {
    it("filters by packageId within the org", async () => {
      const pkg2 = await seedPackage({
        orgId,
        id: `@${orgSlug}/other-agent`,
        draftManifest: {
          name: `@${orgSlug}/other-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Other agent",
        },
      });

      await createSchedule({ orgId: orgId, applicationId: defaultAppId }, packageId, connectionProfileId, {
        name: "Agent 1 Schedule",
        cronExpression: "0 * * * *",
      });
      await createSchedule({ orgId: orgId, applicationId: defaultAppId }, pkg2.id, connectionProfileId, {
        name: "Agent 2 Schedule",
        cronExpression: "*/15 * * * *",
      });

      const schedules = await listPackageSchedules(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
      );
      expect(schedules).toHaveLength(1);
      expect(schedules[0]!.name).toBe("Agent 1 Schedule");

      const schedules2 = await listPackageSchedules(
        { orgId: orgId, applicationId: defaultAppId },
        pkg2.id,
      );
      expect(schedules2).toHaveLength(1);
      expect(schedules2[0]!.name).toBe("Agent 2 Schedule");
    });

    it("returns empty array for package with no schedules", async () => {
      const schedules = await listPackageSchedules(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
      );
      expect(schedules).toBeArray();
      expect(schedules).toHaveLength(0);
    });
  });

  // ── getSchedule ─────────────────────────────────────────

  describe("getSchedule", () => {
    it("returns an existing schedule", async () => {
      const created = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          name: "Hourly Run",
          cronExpression: "0 * * * *",
          timezone: "America/New_York",
        },
      );

      const found = await getSchedule(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("Hourly Run");
      expect(found!.cronExpression).toBe("0 * * * *");
      expect(found!.timezone).toBe("America/New_York");
      expect(found!.packageId).toBe(packageId);
    });

    it("returns null for a non-existent ID", async () => {
      const found = await getSchedule("sched_nonexistent");
      expect(found).toBeNull();
    });
  });

  // ── updateSchedule ──────────────────────────────────────

  describe("updateSchedule", () => {
    it("updates cronExpression and recomputes nextRunAt", async () => {
      const created = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          cronExpression: "0 * * * *",
        },
      );

      const updated = await updateSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        created.id,
        {
          cronExpression: "*/5 * * * *",
        },
      );

      expect(updated).not.toBeNull();
      expect(updated!.cronExpression).toBe("*/5 * * * *");
      expect(updated!.nextRunAt).toBeInstanceOf(Date);
      expect(updated!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it("updates name", async () => {
      const created = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          name: "Original Name",
          cronExpression: "0 * * * *",
        },
      );

      const updated = await updateSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        created.id,
        {
          name: "Updated Name",
        },
      );

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Updated Name");
    });

    it("clears overrides when set to null, keeps when undefined", async () => {
      const created = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          cronExpression: "0 9 * * *",
          configOverride: { foo: "bar" },
          modelIdOverride: "model_init",
          proxyIdOverride: "prx_init",
          versionOverride: "1.0.0",
        },
      );

      // Cron-only update — overrides untouched (undefined leaves them).
      const partialUpdate = await updateSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        created.id,
        { cronExpression: "*/15 * * * *" },
      );
      expect(partialUpdate!.configOverride).toEqual({ foo: "bar" });
      expect(partialUpdate!.modelIdOverride).toBe("model_init");
      expect(partialUpdate!.proxyIdOverride).toBe("prx_init");
      expect(partialUpdate!.versionOverride).toBe("1.0.0");

      // Explicit null clears the override (UI's "Inherit" sentinel).
      const cleared = await updateSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        created.id,
        {
          configOverride: null,
          modelIdOverride: null,
          proxyIdOverride: null,
          versionOverride: null,
        },
      );
      expect(cleared!.configOverride).toBeNull();
      expect(cleared!.modelIdOverride).toBeNull();
      expect(cleared!.proxyIdOverride).toBeNull();
      expect(cleared!.versionOverride).toBeNull();
    });

    it("sets nextRunAt to null when enabled is false", async () => {
      const created = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          cronExpression: "0 * * * *",
        },
      );

      expect(created.enabled).toBe(true);
      expect(created.nextRunAt).not.toBeNull();

      const updated = await updateSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        created.id,
        {
          enabled: false,
        },
      );

      expect(updated).not.toBeNull();
      expect(updated!.enabled).toBe(false);
      expect(updated!.nextRunAt).toBeNull();
    });

    it("re-enables and recomputes nextRunAt", async () => {
      const created = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          cronExpression: "0 * * * *",
        },
      );

      await updateSchedule({ orgId: orgId, applicationId: defaultAppId }, created.id, {
        enabled: false,
      });

      const updated = await updateSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        created.id,
        { enabled: true },
      );

      expect(updated).not.toBeNull();
      expect(updated!.enabled).toBe(true);
      expect(updated!.nextRunAt).toBeInstanceOf(Date);
      expect(updated!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it("updates input data", async () => {
      const created = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          cronExpression: "0 * * * *",
          input: { key: "original" },
        },
      );

      const updated = await updateSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        created.id,
        {
          input: { key: "updated", extra: true },
        },
      );

      expect(updated).not.toBeNull();
      expect(updated!.input).toEqual({ key: "updated", extra: true });
    });

    it("returns null for a non-existent ID", async () => {
      const updated = await updateSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        "sched_nonexistent",
        {
          cronExpression: "*/5 * * * *",
        },
      );
      expect(updated).toBeNull();
    });
  });

  // ── deleteSchedule ──────────────────────────────────────

  describe("deleteSchedule", () => {
    it("removes the record and returns true", async () => {
      const created = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          cronExpression: "0 * * * *",
        },
      );

      const deleted = await deleteSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        created.id,
      );
      expect(deleted).toBe(true);

      const found = await getSchedule(created.id);
      expect(found).toBeNull();
    });

    it("returns false for a non-existent ID", async () => {
      const deleted = await deleteSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        "sched_nonexistent",
      );
      expect(deleted).toBe(false);
    });

    it("does not affect other schedules", async () => {
      const schedule1 = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          name: "Keep This",
          cronExpression: "0 * * * *",
        },
      );
      const schedule2 = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        connectionProfileId,
        {
          name: "Delete This",
          cronExpression: "*/30 * * * *",
        },
      );

      await deleteSchedule({ orgId: orgId, applicationId: defaultAppId }, schedule2.id);

      const remaining = await listSchedules({ orgId: orgId, applicationId: defaultAppId });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe(schedule1.id);
      expect(remaining[0]!.name).toBe("Keep This");
    });
  });

  // ── enrichment (readiness + profile info) ─────────────────

  describe("listSchedules enrichment", () => {
    async function seedProviderPackage(id: string) {
      await seedPackage({
        orgId: null,
        id,
        type: "provider",
        source: "system",
        draftManifest: {
          name: id,
          version: "1.0.0",
          type: "provider",
          description: `Provider ${id}`,
          definition: { authMode: "api_key" },
        },
      });
      await db.insert(applicationProviderCredentials).values({
        applicationId: defaultAppId,
        providerId: id,
        credentialsEncrypted: "{}",
        enabled: true,
      });
    }

    it("returns profileName and readiness 'ready' when agent has no providers", async () => {
      await createSchedule({ orgId: orgId, applicationId: defaultAppId }, packageId, connectionProfileId, {
        name: "No Providers",
        cronExpression: "0 * * * *",
      });

      const schedules = await listSchedules({ orgId: orgId, applicationId: defaultAppId });

      expect(schedules).toHaveLength(1);
      const s = schedules[0]!;
      expect(s.profileName).toBe("Default");
      expect(s.profileType).toBe("user");
      expect(s.readiness).toEqual({
        status: "ready",
        totalProviders: 0,
        connectedProviders: 0,
        missingProviders: [],
      });
    });

    it("returns readiness 'not_ready' when provider has no connection", async () => {
      const providerId = "@system/sched-gmail";
      await seedProviderPackage(providerId);

      const agentWithProvider = await seedPackage({
        orgId,
        id: `@${orgSlug}/agent-with-provider`,
        draftManifest: {
          name: `@${orgSlug}/agent-with-provider`,
          version: "0.1.0",
          type: "agent",
          description: "Agent needing a provider",
          dependencies: { providers: { [providerId]: "*" } },
        },
      });

      await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        agentWithProvider.id,
        connectionProfileId,
        {
          name: "Missing Connection",
          cronExpression: "0 * * * *",
        },
      );

      const schedules = await listSchedules({ orgId: orgId, applicationId: defaultAppId });
      const s = schedules.find((s) => s.name === "Missing Connection")!;

      expect(s.readiness.status).toBe("not_ready");
      expect(s.readiness.totalProviders).toBe(1);
      expect(s.readiness.connectedProviders).toBe(0);
      expect(s.readiness.missingProviders).toEqual([providerId]);
    });

    it("returns readiness 'ready' when provider is connected", async () => {
      const providerId = "@system/sched-connected";
      await seedProviderPackage(providerId);
      await seedConnectionForApp(connectionProfileId, providerId, orgId, defaultAppId, { api_key: "k" });

      const agentConnected = await seedPackage({
        orgId,
        id: `@${orgSlug}/agent-connected`,
        draftManifest: {
          name: `@${orgSlug}/agent-connected`,
          version: "0.1.0",
          type: "agent",
          description: "Connected agent",
          dependencies: { providers: { [providerId]: "*" } },
        },
      });

      await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        agentConnected.id,
        connectionProfileId,
        {
          name: "Connected Schedule",
          cronExpression: "0 * * * *",
        },
      );

      const schedules = await listSchedules({ orgId: orgId, applicationId: defaultAppId });
      const s = schedules.find((s) => s.name === "Connected Schedule")!;

      expect(s.readiness.status).toBe("ready");
      expect(s.readiness.totalProviders).toBe(1);
      expect(s.readiness.connectedProviders).toBe(1);
      expect(s.readiness.missingProviders).toEqual([]);
    });

    // Org-profile readiness tests are in scheduler-org-readiness.test.ts
    // (isolated to avoid BullMQ fire-and-forget race conditions)

    it("cascade-deletes schedule when profile is deleted", async () => {
      const tempProfile = await seedConnectionProfile({ userId, name: "Temp" });

      const schedule = await createSchedule(
        { orgId: orgId, applicationId: defaultAppId },
        packageId,
        tempProfile.id,
        {
          name: "Deleted Profile",
          cronExpression: "0 * * * *",
        },
      );

      await db.delete(connectionProfiles).where(eq(connectionProfiles.id, tempProfile.id));

      const found = await getSchedule(schedule.id);
      expect(found).toBeNull();

      const schedules = await listSchedules({ orgId: orgId, applicationId: defaultAppId });
      expect(schedules.find((s) => s.name === "Deleted Profile")).toBeUndefined();
    });
  });
});
