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
import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, organizationMembers, runs, schedules } from "@appstrate/db/schema";
import { Queue, type ConnectionOptions } from "bullmq";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestUser,
  createTestOrg,
  addOrgMember,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedSpace, seedSpacePackage, seedEndUser } from "../../helpers/seed.ts";
import type { Actor } from "../../../src/lib/actor.ts";
import type { SpaceScope } from "../../../src/lib/scope.ts";
import { flushRedis, closeRedis } from "../../helpers/redis.ts";
import { describeRequiresRedis } from "../../helpers/tier.ts";
import {
  createSchedule,
  listSchedules,
  listPackageSchedules,
  getSchedule,
  updateSchedule,
  deleteSchedule,
  triggerScheduledRun,
  removeScheduleJobs,
} from "../../../src/services/scheduler.ts";
import { deleteIntegrationConnection } from "../../../src/services/integration-connections.ts";
import { updateConnectionMetadata } from "../../../src/services/integration-pins-service.ts";
import { leaveOrganization, updateMemberRole } from "../../../src/services/organizations.ts";
import { getRedisQueueConnection } from "../../../src/lib/redis.ts";

// Real BullMQ repeatable-job semantics — skipped in tier0 (in-memory queue).
describeRequiresRedis("scheduler service", () => {
  let userId: string;
  let orgId: string;
  let orgSlug: string;
  let defaultSpaceId: string;
  let packageId: string;
  let actor: Actor;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org, defaultSpaceId: spaceId } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    orgSlug = org.slug;
    defaultSpaceId = spaceId;

    actor = { type: "user", id: userId };

    // Seed an agent package that schedules will reference — PLACED here (the
    // default space is its home) and ACTIVE here (`space_packages`, enabled by
    // default). Both halves are fixture, not subject: the tick asks the
    // executable predicate (`agentExecutionBlock` — placed ∧ active, RBAC spec
    // §6.9) BEFORE it resolves a version or reads a manifest, so an agent
    // homed nowhere would make every `triggerScheduledRun` case below fail on
    // placement and assert nothing about what it means to assert.
    // `scheduler-activation-gate.test.ts` is the suite that owns that gate.
    const pkg = await seedPackage({
      orgId,
      id: `@${orgSlug}/scheduled-agent`,
      homeSpaceId: defaultSpaceId,
      draftManifest: {
        name: `@${orgSlug}/scheduled-agent`,
        version: "0.1.0",
        type: "agent",
        description: "An agent for schedule tests",
      },
    });
    packageId = pkg.id;
    await seedSpacePackage(defaultSpaceId, packageId);
  });

  afterAll(async () => {
    await closeRedis();
  });

  // ── createSchedule ──────────────────────────────────────

  describe("createSchedule", () => {
    it("creates a record with correct fields", async () => {
      const schedule = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          name: "Every hour",
          cronExpression: "0 * * * *",
          timezone: "UTC",
        },
      );

      expect(schedule.id).toMatch(/^sched_/);
      expect(schedule.packageId).toBe(packageId);
      expect(schedule.orgId).toBe(orgId);
      expect(schedule.userId).toBe(userId);
      expect(schedule.cron_expression).toBe("0 * * * *");
      expect(schedule.timezone).toBe("UTC");
      expect(schedule.enabled).toBe(true);
      expect(schedule.name).toBe("Every hour");
      expect(typeof schedule.next_run_at).toBe("string");
      expect(typeof schedule.createdAt).toBe("string");
    });

    it("stores JSON input when provided", async () => {
      const inputData = { query: "test search", limit: 10 };

      const schedule = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "*/5 * * * *",
          input: inputData,
        },
      );

      expect(schedule.input).toEqual(inputData);
    });

    it("defaults timezone to UTC when not specified", async () => {
      const schedule = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "0 9 * * *",
        },
      );

      expect(schedule.timezone).toBe("UTC");
    });

    it("computes nextRunAt in the future", async () => {
      const schedule = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "0 * * * *",
          timezone: "UTC",
        },
      );

      expect(schedule.next_run_at).not.toBeNull();
      expect(new Date(schedule.next_run_at!).getTime()).toBeGreaterThan(Date.now());
    });

    it("persists per-schedule overrides verbatim", async () => {
      const schedule = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "0 9 * * *",
          generationConfigOverride: { temperature: 0, reasoning_level: "high" },
          modelIdOverride: "model_abc",
          proxyIdOverride: "prx_xyz",
          versionOverride: "1.2.3",
        },
      );

      expect(schedule.generation_config_override).toEqual({
        temperature: 0,
        reasoning_level: "high",
      });
      expect(schedule.model_id_override).toBe("model_abc");
      expect(schedule.proxy_id_override).toBe("prx_xyz");
      expect(schedule.version_override).toBe("1.2.3");
    });

    it("defaults all overrides to null when omitted", async () => {
      const schedule = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "0 9 * * *",
        },
      );

      expect(schedule.generation_config_override).toBeNull();
      expect(schedule.model_id_override).toBeNull();
      expect(schedule.proxy_id_override).toBeNull();
      expect(schedule.version_override).toBeNull();
    });
  });

  // ── listSchedules ───────────────────────────────────────

  describe("listSchedules", () => {
    it("returns schedules for the org", async () => {
      await createSchedule({ orgId: orgId, spaceId: defaultSpaceId }, packageId, actor, {
        name: "Schedule A",
        cronExpression: "0 * * * *",
      });
      await createSchedule({ orgId: orgId, spaceId: defaultSpaceId }, packageId, actor, {
        name: "Schedule B",
        cronExpression: "*/30 * * * *",
      });

      const schedules = await listSchedules(
        { orgId: orgId, spaceId: defaultSpaceId },
        actor,
        undefined,
      );

      expect(schedules).toHaveLength(2);
      const names = schedules.map((s) => s.name);
      expect(names).toContain("Schedule A");
      expect(names).toContain("Schedule B");
    });

    it("does not return schedules from other orgs", async () => {
      await createSchedule({ orgId: orgId, spaceId: defaultSpaceId }, packageId, actor, {
        name: "My Schedule",
        cronExpression: "0 * * * *",
      });

      const otherUser = await createTestUser({ email: "other@test.com" });
      const { org: otherOrg, defaultSpaceId: otherDefaultSpaceId } = await createTestOrg(
        otherUser.id,
        {
          slug: "otherorg",
        },
      );
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
      await createSchedule(
        { orgId: otherOrg.id, spaceId: otherDefaultSpaceId },
        otherPkg.id,
        { type: "user", id: otherUser.id },
        {
          name: "Other Schedule",
          cronExpression: "0 * * * *",
        },
      );

      const schedules = await listSchedules(
        { orgId: orgId, spaceId: defaultSpaceId },
        actor,
        undefined,
      );
      expect(schedules).toHaveLength(1);
      expect(schedules[0]!.name).toBe("My Schedule");

      const otherSchedules = await listSchedules(
        { orgId: otherOrg.id, spaceId: otherDefaultSpaceId },
        actor,
        undefined,
      );
      expect(otherSchedules).toHaveLength(1);
      expect(otherSchedules[0]!.name).toBe("Other Schedule");
    });

    it("returns an empty array when no schedules exist", async () => {
      const schedules = await listSchedules(
        { orgId: orgId, spaceId: defaultSpaceId },
        actor,
        undefined,
      );
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

      await createSchedule({ orgId: orgId, spaceId: defaultSpaceId }, packageId, actor, {
        name: "Agent 1 Schedule",
        cronExpression: "0 * * * *",
      });
      await createSchedule({ orgId: orgId, spaceId: defaultSpaceId }, pkg2.id, actor, {
        name: "Agent 2 Schedule",
        cronExpression: "*/15 * * * *",
      });

      const schedules = await listPackageSchedules(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        undefined,
      );
      expect(schedules).toHaveLength(1);
      expect(schedules[0]!.name).toBe("Agent 1 Schedule");

      const schedules2 = await listPackageSchedules(
        { orgId: orgId, spaceId: defaultSpaceId },
        pkg2.id,
        actor,
        undefined,
      );
      expect(schedules2).toHaveLength(1);
      expect(schedules2[0]!.name).toBe("Agent 2 Schedule");
    });

    it("returns empty array for package with no schedules", async () => {
      const schedules = await listPackageSchedules(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        undefined,
      );
      expect(schedules).toBeArray();
      expect(schedules).toHaveLength(0);
    });
  });

  // ── getSchedule ─────────────────────────────────────────

  describe("getSchedule", () => {
    it("returns an existing schedule", async () => {
      const created = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          name: "Hourly Run",
          cronExpression: "0 * * * *",
          timezone: "America/New_York",
        },
      );

      const found = await getSchedule(
        created.id,
        { orgId: orgId, spaceId: defaultSpaceId },
        null,
        undefined,
      );

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("Hourly Run");
      expect(found!.cron_expression).toBe("0 * * * *");
      expect(found!.timezone).toBe("America/New_York");
      expect(found!.packageId).toBe(packageId);
    });

    it("returns null for a non-existent ID", async () => {
      const found = await getSchedule(
        "sched_nonexistent",
        { orgId: orgId, spaceId: defaultSpaceId },
        null,
        undefined,
      );
      expect(found).toBeNull();
    });
  });

  // ── updateSchedule ──────────────────────────────────────

  describe("updateSchedule", () => {
    it("updates cronExpression and recomputes nextRunAt", async () => {
      const created = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "0 * * * *",
        },
      );

      const updated = await updateSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        created,
        {
          cronExpression: "*/5 * * * *",
        },
        null,
        undefined,
      );

      expect(updated).not.toBeNull();
      expect(updated!.cron_expression).toBe("*/5 * * * *");
      expect(typeof updated!.next_run_at).toBe("string");
      expect(new Date(updated!.next_run_at!).getTime()).toBeGreaterThan(Date.now());
    });

    it("updates name", async () => {
      const created = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          name: "Original Name",
          cronExpression: "0 * * * *",
        },
      );

      const updated = await updateSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        created,
        {
          name: "Updated Name",
        },
        null,
        undefined,
      );

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Updated Name");
    });

    it("clears overrides when set to null, keeps when undefined", async () => {
      const created = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "0 9 * * *",
          generationConfigOverride: { reasoning_level: "low" },
          modelIdOverride: "model_init",
          proxyIdOverride: "prx_init",
          versionOverride: "1.0.0",
        },
      );

      // Cron-only update — overrides untouched (undefined leaves them).
      const partialUpdate = await updateSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        created,
        { cronExpression: "*/15 * * * *" },
        null,
        undefined,
      );
      expect(partialUpdate!.generation_config_override).toEqual({ reasoning_level: "low" });
      expect(partialUpdate!.model_id_override).toBe("model_init");
      expect(partialUpdate!.proxy_id_override).toBe("prx_init");
      expect(partialUpdate!.version_override).toBe("1.0.0");

      // Explicit null clears the override (UI's "Inherit" sentinel).
      // Judged against the row the previous write left (its cron moved).
      const cleared = await updateSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        partialUpdate,
        {
          generationConfigOverride: null,
          modelIdOverride: null,
          proxyIdOverride: null,
          versionOverride: null,
        },
        null,
        undefined,
      );
      expect(cleared!.generation_config_override).toBeNull();
      expect(cleared!.model_id_override).toBeNull();
      expect(cleared!.proxy_id_override).toBeNull();
      expect(cleared!.version_override).toBeNull();
    });

    it("sets nextRunAt to null when enabled is false", async () => {
      const created = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "0 * * * *",
        },
      );

      expect(created.enabled).toBe(true);
      expect(created.next_run_at).not.toBeNull();

      const updated = await updateSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        created,
        {
          enabled: false,
        },
        null,
        undefined,
      );

      expect(updated).not.toBeNull();
      expect(updated!.enabled).toBe(false);
      expect(updated!.next_run_at).toBeNull();
    });

    it("re-enables and recomputes nextRunAt", async () => {
      const created = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "0 * * * *",
        },
      );

      const disabled = await updateSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        created,
        {
          enabled: false,
        },
        null,
        undefined,
      );

      const updated = await updateSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        disabled,
        {
          enabled: true,
        },
        null,
        undefined,
      );

      expect(updated).not.toBeNull();
      expect(updated!.enabled).toBe(true);
      expect(typeof updated!.next_run_at).toBe("string");
      expect(new Date(updated!.next_run_at!).getTime()).toBeGreaterThan(Date.now());
    });

    it("updates input data", async () => {
      const created = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "0 * * * *",
          input: { key: "original" },
        },
      );

      const updated = await updateSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        created,
        {
          input: { key: "updated", extra: true },
        },
        null,
        undefined,
      );

      expect(updated).not.toBeNull();
      expect(updated!.input).toEqual({ key: "updated", extra: true });
    });
  });

  // ── deleteSchedule ──────────────────────────────────────

  describe("deleteSchedule", () => {
    it("removes the record and returns true", async () => {
      const created = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "0 * * * *",
        },
      );

      const deleted = await deleteSchedule({ orgId: orgId, spaceId: defaultSpaceId }, created.id);
      expect(deleted).toBe(true);

      const found = await getSchedule(
        created.id,
        { orgId: orgId, spaceId: defaultSpaceId },
        null,
        undefined,
      );
      expect(found).toBeNull();
    });

    it("returns false for a non-existent ID", async () => {
      const deleted = await deleteSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        "sched_nonexistent",
      );
      expect(deleted).toBe(false);
    });

    it("does not affect other schedules", async () => {
      const schedule1 = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          name: "Keep This",
          cronExpression: "0 * * * *",
        },
      );
      const schedule2 = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          name: "Delete This",
          cronExpression: "*/30 * * * *",
        },
      );

      await deleteSchedule({ orgId: orgId, spaceId: defaultSpaceId }, schedule2.id);

      const remaining = await listSchedules(
        { orgId: orgId, spaceId: defaultSpaceId },
        actor,
        undefined,
      );
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe(schedule1.id);
      expect(remaining[0]!.name).toBe("Keep This");
    });
  });

  // ── triggerScheduledRun — version resolution (#636 breaking surface) ──
  //
  // The unified model (omit ≡ `published`) means an INHERITING schedule on a
  // never-published agent no longer silently runs the draft — it 404s. This is
  // the riskiest surface of the breaking change because it fires in the BullMQ
  // worker, not in a request: the resolver + run-route tests prove the 404, but
  // only this asserts the worker turns it into a VISIBLE failed run instead of
  // a silent skip. (The seeded agent is a never-published draft.)

  describe("triggerScheduledRun version resolution", () => {
    it("surfaces a failed run when an inheriting schedule fires on a never-published agent", async () => {
      const schedule = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        { cronExpression: "0 * * * *" }, // no versionOverride → inherit
      );

      // Inherit (no versionOverride) → resolves to `published` → 404
      // no_published_version → caught → failSchedule(). Stops before preflight,
      // so nothing executes.
      await triggerScheduledRun(schedule.id);

      const failed = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(failed).toHaveLength(1);
      expect(failed[0]!.status).toBe("failed");
      expect((failed[0]!.error ?? "").toLowerCase()).toContain("no published version");
    });
  });

  // ── triggerScheduledRun — declared-but-unspawnable integration (#737) ──
  //
  // The schedule has an actor, but the agent declares an integration whose
  // package does not exist. resolveOne would skip it silently at spawn
  // (`fetchIntegrationManifest` → not_found → null), so the run would otherwise
  // finish `success` without the integration's tools. The readiness
  // manifest-health gate must turn this into a VISIBLE failed run on the
  // scheduled path too (parity with the 409 on the request path).

  describe("triggerScheduledRun integration manifest health (#737)", () => {
    it("fails fast with a visible failed run when a declared integration package is missing", async () => {
      // Placed + active here, like the suite's own agent: the integration this
      // case is about is only reached once the execution gate has passed.
      const agent = await seedPackage({
        orgId,
        id: `@${orgSlug}/missing-integration-agent`,
        homeSpaceId: defaultSpaceId,
        draftManifest: {
          name: `@${orgSlug}/missing-integration-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Agent declaring a non-existent integration",
          dependencies: { integrations: { "@vendor/does-not-exist": "1.0.0" } },
        },
      });
      await seedSpacePackage(defaultSpaceId, agent.id);

      const schedule = await createSchedule({ orgId, spaceId: defaultSpaceId }, agent.id, actor, {
        cronExpression: "0 * * * *",
        versionOverride: "draft",
      });

      await triggerScheduledRun(schedule.id);

      const failed = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(failed).toHaveLength(1);
      expect(failed[0]!.status).toBe("failed");
      const err = (failed[0]!.error ?? "").toLowerCase();
      expect(err).toContain("no such package");
    });
  });

  // ── triggerScheduledRun — fire-time actor revalidation (CRIT-13) ──
  //
  // A removed member keeps their `user` row (multi-org), and the schedule row
  // only cascades on account deletion — so a schedule the removeMember cleanup
  // missed would keep firing under the revoked identity. The fire path must
  // revalidate the row's actor on EVERY fire and, when
  // invalid, disable the schedule and record a VISIBLE FAILED run — never a
  // silent skip and never a false-positive `success`.

  describe("triggerScheduledRun fire-time actor revalidation (CRIT-13)", () => {
    it("a schedule whose user actor is no longer a member fires into a FAILED run and is disabled", async () => {
      // Member M owns the schedule as its execution actor.
      const member = await createTestUser({ email: "revoked-member@test.com" });
      await addOrgMember(orgId, member.id, "member");
      const actorM: Actor = { type: "user", id: member.id };

      const schedule = await createSchedule({ orgId, spaceId: defaultSpaceId }, packageId, actorM, {
        cronExpression: "0 * * * *",
      });
      expect(schedule.enabled).toBe(true);

      // Revoke the membership DIRECTLY (bypassing removeMember's own schedule
      // disable) — this simulates the backstop case: a schedule the
      // revocation path left armed now fires with the row's actor.
      await db
        .delete(organizationMembers)
        .where(
          and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, member.id)),
        );

      await triggerScheduledRun(schedule.id);

      // VISIBLE failed run — never a silent skip, never `success`.
      const fired = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(fired).toHaveLength(1);
      expect(fired[0]!.status).toBe("failed");
      expect(fired[0]!.error ?? "").toStartWith("Schedule disabled: ");
      expect((fired[0]!.error ?? "").toLowerCase()).toContain(
        "is not a member of this organization",
      );

      // The schedule is disabled so the revoked identity never fires again.
      const [row] = await db
        .select({
          enabled: schedules.enabled,
          disabledReason: schedules.disabledReason,
          nextRunAt: schedules.nextRunAt,
        })
        .from(schedules)
        .where(eq(schedules.id, schedule.id));
      expect(row!.enabled).toBe(false);
      expect(row!.disabledReason).toBe("actor_invalid");
      expect(row!.nextRunAt).toBeNull();
    });

    it("a fire racing a person's pause records no reason", async () => {
      const member = await createTestUser({ email: "racing-disable@test.com" });
      await addOrgMember(orgId, member.id, "member");
      const schedule = await createSchedule(
        { orgId, spaceId: defaultSpaceId },
        packageId,
        { type: "user", id: member.id },
        { cronExpression: "0 * * * *" },
      );
      await db
        .delete(organizationMembers)
        .where(
          and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, member.id)),
        );

      // The pause lands after the fire read the row enabled.
      await triggerScheduledRun(schedule.id, async () => {
        await db
          .update(schedules)
          .set({ enabled: false, nextRunAt: null })
          .where(eq(schedules.id, schedule.id));
        return true;
      });

      const [row] = await db
        .select({ enabled: schedules.enabled, disabledReason: schedules.disabledReason })
        .from(schedules)
        .where(eq(schedules.id, schedule.id));
      expect(row).toEqual({ enabled: false, disabledReason: null });
    });

    it("a schedule whose end-user actor does not exist in the space fires into a FAILED run and is disabled", async () => {
      // The end user exists — but in a DIFFERENT space of the same org,
      // so the fire-time revalidation (end user must exist in the SCHEDULE's
      // space) fails.
      const otherSpace = await seedSpace({ orgId });
      const foreignEndUser = await seedEndUser({ spaceId: otherSpace.id, orgId });
      const actorEu: Actor = { type: "end_user", id: foreignEndUser.id };

      const schedule = await createSchedule(
        { orgId, spaceId: defaultSpaceId },
        packageId,
        actorEu,
        { cronExpression: "0 * * * *" },
      );

      await triggerScheduledRun(schedule.id);

      const fired = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(fired).toHaveLength(1);
      expect(fired[0]!.status).toBe("failed");
      expect((fired[0]!.error ?? "").toLowerCase()).toContain("end-user");

      const [row] = await db
        .select({
          enabled: schedules.enabled,
          disabledReason: schedules.disabledReason,
          nextRunAt: schedules.nextRunAt,
        })
        .from(schedules)
        .where(eq(schedules.id, schedule.id));
      expect(row!.enabled).toBe(false);
      expect(row!.disabledReason).toBe("actor_invalid");
      expect(row!.nextRunAt).toBeNull();
    });

    it("a valid member actor does NOT trip the revalidation (control — fails later, not on membership)", async () => {
      // The seeded agent is a never-published draft, so an inheriting
      // schedule fails on version resolution — NOT on actor validity, and the
      // schedule stays ENABLED (revalidation only disables on invalid actor).
      const schedule = await createSchedule({ orgId, spaceId: defaultSpaceId }, packageId, actor, {
        cronExpression: "0 * * * *",
      });

      await triggerScheduledRun(schedule.id);

      const fired = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(fired).toHaveLength(1);
      expect((fired[0]!.error ?? "").toLowerCase()).not.toContain(
        "is not a member of this organization",
      );
      // …and it failed on the version, POSITIVELY: a control that only names
      // the cause it rules out passes on any other refusal — including the
      // execution gate two steps later — and would have reported "the actor
      // was fine" about a fire that never reached the resolver at all.
      expect((fired[0]!.error ?? "").toLowerCase()).toContain("no published version");

      const [row] = await db
        .select({ enabled: schedules.enabled })
        .from(schedules)
        .where(eq(schedules.id, schedule.id));
      expect(row!.enabled).toBe(true);
    });
  });

  // ── triggerScheduledRun reads the row, never a job payload ──
  //
  // A job only names its schedule: one armed out of order, or one whose
  // removal failed, must neither fire a disabled/deleted schedule nor replay
  // values the row no longer holds.

  describe("triggerScheduledRun reads the schedule row", () => {
    async function jobOf(scheduleId: string) {
      const queue = new Queue("schedules", {
        connection: getRedisQueueConnection() as unknown as ConnectionOptions,
      });
      try {
        return await queue.getJobScheduler(scheduleId);
      } finally {
        await queue.close();
      }
    }

    it("skips a schedule disabled behind its armed job, and removes the job", async () => {
      const schedule = await createSchedule({ orgId, spaceId: defaultSpaceId }, packageId, actor, {
        cronExpression: "0 * * * *",
      });
      expect((await jobOf(schedule.id))?.template?.data).toEqual({ scheduleId: schedule.id });
      await db.update(schedules).set({ enabled: false }).where(eq(schedules.id, schedule.id));

      expect(await triggerScheduledRun(schedule.id)).toBeNull();
      expect(await db.select().from(runs).where(eq(runs.scheduleId, schedule.id))).toHaveLength(0);
      expect(await jobOf(schedule.id)).toBeUndefined();
    });

    it("skips a schedule deleted behind its armed job, and removes the job", async () => {
      const schedule = await createSchedule({ orgId, spaceId: defaultSpaceId }, packageId, actor, {
        cronExpression: "0 * * * *",
      });
      await db.delete(schedules).where(eq(schedules.id, schedule.id));

      expect(await triggerScheduledRun(schedule.id)).toBeNull();
      expect(await jobOf(schedule.id)).toBeUndefined();
    });

    it("fires as the row's CURRENT actor, not the one it was armed with", async () => {
      const schedule = await createSchedule({ orgId, spaceId: defaultSpaceId }, packageId, actor, {
        cronExpression: "0 * * * *",
      });
      // Re-pointed without re-arming the job: an end user of ANOTHER space fails revalidation.
      const otherSpace = await seedSpace({ orgId });
      const foreign = await seedEndUser({ spaceId: otherSpace.id, orgId });
      await db
        .update(schedules)
        .set({ userId: null, endUserId: foreign.id })
        .where(eq(schedules.id, schedule.id));

      expect(await triggerScheduledRun(schedule.id)).not.toBeNull();
      const [fired] = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(fired!.endUserId).toBe(foreign.id);
      expect((fired!.error ?? "").toLowerCase()).toContain("end-user");
    });
  });

  // ── Cross-space isolation (same org, different space) ────
  //
  // Every scheduler CRUD predicate is scoped by BOTH `orgId` and `spaceId`
  // (`scopedWhere`). A cross-ORG case is satisfied by the org half alone, so
  // it cannot tell a present `spaceId` predicate from a missing one — drop
  // any of them and a second space in the same org sees, edits and deletes
  // the first space's schedules. These cases are the only thing standing
  // between that and a silent org-wide leak. Mirrors the shape of
  // `routes/notifications.test.ts` → "cross-space isolation".
  describe("cross-space isolation", () => {
    let spaceBId: string;
    let scheduleIdInA: string;
    let scheduleInA: Awaited<ReturnType<typeof createSchedule>>;

    beforeEach(async () => {
      const spaceB = await seedSpace({ orgId, name: "Space B" });
      spaceBId = spaceB.id;
      const created = await createSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        { name: "Space A Schedule", cronExpression: "0 * * * *" },
      );
      scheduleIdInA = created.id;
      scheduleInA = created;
    });

    it("does not list a schedule belonging to another space", async () => {
      expect(
        await listSchedules({ orgId: orgId, spaceId: spaceBId }, actor, undefined),
      ).toHaveLength(0);
      // Control: the same org, the owning space — still there.
      expect(
        await listSchedules({ orgId: orgId, spaceId: defaultSpaceId }, actor, undefined),
      ).toHaveLength(1);
    });

    it("does not list a package's schedules from another space", async () => {
      expect(
        await listPackageSchedules(
          { orgId: orgId, spaceId: spaceBId },
          packageId,
          actor,
          undefined,
        ),
      ).toHaveLength(0);
      expect(
        await listPackageSchedules(
          { orgId: orgId, spaceId: defaultSpaceId },
          packageId,
          actor,
          undefined,
        ),
      ).toHaveLength(1);
    });

    it("does not resolve a schedule by id from another space", async () => {
      expect(
        await getSchedule(scheduleIdInA, { orgId: orgId, spaceId: spaceBId }, actor, undefined),
      ).toBeNull();
      expect(
        await getSchedule(
          scheduleIdInA,
          { orgId: orgId, spaceId: defaultSpaceId },
          actor,
          undefined,
        ),
      ).not.toBeNull();
    });

    // `updateSchedule` writes against the caller's snapshot, so the UPDATE's `spaceId` predicate
    // is what stands here: another space's snapshot matches no row and writes nothing.
    it("refuses an update issued from another space, and the row is unchanged", async () => {
      await expect(
        updateSchedule(
          { orgId: orgId, spaceId: spaceBId },
          scheduleInA,
          {
            name: "Hijacked",
          },
          null,
          undefined,
        ),
      ).rejects.toMatchObject({ status: 409 });
      const survivor = await getSchedule(
        scheduleIdInA,
        { orgId: orgId, spaceId: defaultSpaceId },
        actor,
        undefined,
      );
      expect(survivor?.name).toBe("Space A Schedule");
    });

    it("reports no delete from another space, and the row survives", async () => {
      expect(await deleteSchedule({ orgId: orgId, spaceId: spaceBId }, scheduleIdInA)).toBe(false);
      expect(
        await getSchedule(
          scheduleIdInA,
          { orgId: orgId, spaceId: defaultSpaceId },
          actor,
          undefined,
        ),
      ).not.toBeNull();
      // Control: the identical call from the OWNING space does delete, so
      // "false + survives" above is the predicate at work, not a broken id.
      expect(await deleteSchedule({ orgId: orgId, spaceId: defaultSpaceId }, scheduleIdInA)).toBe(
        true,
      );
    });
  });

  // ── a connection delete and the owner's schedule jobs ──
  //
  // The fire reads the pruned row; the job only has to follow `enabled`.

  describe("deleteIntegrationConnection and the owner's schedule job", () => {
    it("a shrunk set keeps the job armed, naming only the schedule", async () => {
      const integrationId = `@${orgSlug}/svc`;
      await seedPackage({ orgId, id: integrationId, type: "integration", source: "local" });
      const [kept, gone] = await Promise.all(
        ["kept", "gone"].map(async (label) => {
          const [row] = await db
            .insert(integrationConnections)
            .values({
              integrationId,
              authKey: "primary",
              accountId: `acct-${label}`,
              spaceId: defaultSpaceId,
              userId,
              credentialsEncrypted: "x",
              scopesGranted: [],
              label,
            })
            .returning({ id: integrationConnections.id });
          return row!.id;
        }),
      );
      const schedule = await createSchedule({ orgId, spaceId: defaultSpaceId }, packageId, actor, {
        cronExpression: "0 * * * *",
        connectionOverrides: { [integrationId]: [kept!, gone!] },
      });

      // What `DELETE /api/me/connections/:id` does: the service prunes, the route drops the jobs
      // of the schedules it disabled.
      const { disabledScheduleIds } = await deleteIntegrationConnection(
        { orgId, spaceId: defaultSpaceId },
        gone!,
        actor,
      );
      expect(disabledScheduleIds).toEqual([]);
      await removeScheduleJobs(disabledScheduleIds);

      const [after] = await db.select().from(schedules).where(eq(schedules.id, schedule.id));
      expect(after).toMatchObject({
        enabled: true,
        connectionOverrides: { [integrationId]: [kept!] },
      });
      const queue = new Queue("schedules", {
        connection: getRedisQueueConnection() as unknown as ConnectionOptions,
      });
      try {
        const job = await queue.getJobScheduler(schedule.id);
        expect(job?.template?.data).toEqual({ scheduleId: schedule.id });
      } finally {
        await queue.close();
      }
    });

    it("an emptied override disables the schedule and removes its job", async () => {
      const integrationId = `@${orgSlug}/svc`;
      await seedPackage({ orgId, id: integrationId, type: "integration", source: "local" });
      const [row] = await db
        .insert(integrationConnections)
        .values({
          integrationId,
          authKey: "primary",
          accountId: "acct-only",
          spaceId: defaultSpaceId,
          userId,
          credentialsEncrypted: "x",
          scopesGranted: [],
          label: "only",
        })
        .returning({ id: integrationConnections.id });
      const schedule = await createSchedule({ orgId, spaceId: defaultSpaceId }, packageId, actor, {
        cronExpression: "0 * * * *",
        connectionOverrides: { [integrationId]: [row!.id] },
      });

      const { disabledScheduleIds } = await deleteIntegrationConnection(
        { orgId, spaceId: defaultSpaceId },
        row!.id,
        actor,
      );
      expect(disabledScheduleIds).toEqual([schedule.id]);
      await removeScheduleJobs(disabledScheduleIds);

      const [after] = await db.select().from(schedules).where(eq(schedules.id, schedule.id));
      expect(after).toMatchObject({
        enabled: false,
        disabledReason: "connection_deleted",
        nextRunAt: null,
        connectionOverrides: null,
      });
      const queue = new Queue("schedules", {
        connection: getRedisQueueConnection() as unknown as ConnectionOptions,
      });
      try {
        expect(await queue.getJobScheduler(schedule.id)).toBeUndefined();
      } finally {
        await queue.close();
      }
    });
  });

  describe("an unshare and a colleague's schedule job", () => {
    it("a demotion that loses the owner the space removes the job of a colleague's schedule", async () => {
      const integrationId = `@${orgSlug}/svc`;
      await seedPackage({ orgId, id: integrationId, type: "integration", source: "local" });
      const admin = await createTestUser();
      await addOrgMember(orgId, admin.id, "admin");
      // No member row: an admin reaches a closed space by org role alone.
      const closed = await seedSpace({ orgId, visibility: "closed" });
      const [conn] = await db
        .insert(integrationConnections)
        .values({
          integrationId,
          authKey: "primary",
          accountId: "acct-admin",
          spaceId: closed.id,
          userId: admin.id,
          credentialsEncrypted: "x",
          scopesGranted: [],
          sharedWithOrg: true,
          label: "admin's",
        })
        .returning({ id: integrationConnections.id });
      const schedule = await createSchedule({ orgId, spaceId: closed.id }, packageId, actor, {
        cronExpression: "0 * * * *",
        connectionOverrides: { [integrationId]: [conn!.id] },
      });

      await updateMemberRole(orgId, admin.id, "member", { userId, firstPartySession: true });

      const [after] = await db.select().from(schedules).where(eq(schedules.id, schedule.id));
      expect(after).toMatchObject({ enabled: false, disabledReason: "connection_unshared" });
      const queue = new Queue("schedules", {
        connection: getRedisQueueConnection() as unknown as ConnectionOptions,
      });
      try {
        expect(await queue.getJobScheduler(schedule.id)).toBeUndefined();
      } finally {
        await queue.close();
      }
    });
  });
});

// A plain `describe`: the compare-and-set is SQL on `updated_at`, no queue semantics, so every tier
// runs it. The snapshot is what the caller's checks judged; a row that moved since writes nothing.
describe("updateSchedule — a compare-and-set on the caller's read", () => {
  let ctx: TestContext;
  let scope: SpaceScope;
  let actor: Actor;
  let packageId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "casorg" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    actor = { type: "user", id: ctx.user.id };
    packageId = (await seedPackage({ orgId: ctx.orgId, id: "@casorg/agent" })).id;
  });

  /** The caller's read of a new schedule — what a PATCH judges, then writes against. */
  function read(as: Actor = actor, connectionOverrides?: Record<string, string[]>) {
    return createSchedule(scope, packageId, as, {
      cronExpression: "0 * * * *",
      ...(connectionOverrides ? { connectionOverrides } : {}),
    });
  }

  const refusedAsStale = { status: 409, code: "schedule_modified_concurrently" };
  // Every schedule writer bumps `updated_at`; a second later stands for "any later write".
  const bumped = sql`${schedules.updatedAt} + interval '1 second'`;

  it("refuses a stale snapshot with 409 and leaves the row as it is", async () => {
    const created = await read();
    await db
      .update(schedules)
      .set({ enabled: false, updatedAt: bumped })
      .where(eq(schedules.id, created.id));

    await expect(
      updateSchedule(scope, created, { name: "renamed" }, null, undefined),
    ).rejects.toMatchObject(refusedAsStale);
    const [row] = await db.select().from(schedules).where(eq(schedules.id, created.id));
    expect(row).toMatchObject({ enabled: false, name: null });
  });

  // One stamp covers every field a check reads, not a list that can miss one.
  it("refuses a snapshot whose row moved on a field no patch check lists, like version_override", async () => {
    const created = await read();
    await db
      .update(schedules)
      .set({ versionOverride: "draft", updatedAt: bumped })
      .where(eq(schedules.id, created.id));

    await expect(
      updateSchedule(scope, created, { enabled: true }, null, undefined),
    ).rejects.toMatchObject(refusedAsStale);
  });

  it("accepts the snapshot of a row stamped by the database clock (microseconds)", async () => {
    const created = await read();
    await db
      .update(schedules)
      .set({ updatedAt: sql`now()` })
      .where(eq(schedules.id, created.id));
    const [fresh] = await db.select().from(schedules).where(eq(schedules.id, created.id));

    const updated = await updateSchedule(
      scope,
      { ...created, updatedAt: fresh!.updatedAt.toISOString() },
      { name: "renamed" },
      null,
      undefined,
    );
    expect(updated.name).toBe("renamed");
  });

  it("refuses a snapshot of a row deleted since, with the same 409", async () => {
    const created = await read();
    await deleteSchedule(scope, created.id);
    await expect(
      updateSchedule(scope, created, { cronExpression: "*/5 * * * *" }, null, undefined),
    ).rejects.toMatchObject(refusedAsStale);
  });

  // The real writers, not a hand-bumped stamp: each must move the token it races.
  it("a connection delete pruning the schedule's set makes the read stale", async () => {
    const integrationId = "@casorg/svc";
    await seedPackage({ orgId: ctx.orgId, id: integrationId, type: "integration" });
    const [kept, gone] = await db
      .insert(integrationConnections)
      .values(
        ["kept", "gone"].map((label) => ({
          integrationId,
          authKey: "primary",
          accountId: label,
          spaceId: ctx.defaultSpaceId,
          userId: ctx.user.id,
          credentialsEncrypted: "x",
          scopesGranted: [],
          label,
        })),
      )
      .returning({ id: integrationConnections.id });
    const created = await read(actor, { [integrationId]: [kept!.id, gone!.id] });

    await deleteIntegrationConnection(scope, gone!.id, actor);

    await expect(
      updateSchedule(scope, created, { name: "renamed" }, null, undefined),
    ).rejects.toMatchObject(refusedAsStale);
  });

  it("a colleague deleting or unsharing a connection the schedule names makes the read stale", async () => {
    const member = await memberContext(ctx, "member");
    const integrationId = "@casorg/svc";
    await seedPackage({ orgId: ctx.orgId, id: integrationId, type: "integration" });
    const [deleted, unshared] = await db
      .insert(integrationConnections)
      .values(
        ["deleted", "unshared"].map((label) => ({
          integrationId,
          authKey: "primary",
          accountId: label,
          spaceId: ctx.defaultSpaceId,
          userId: member.user.id,
          credentialsEncrypted: "x",
          scopesGranted: [],
          sharedWithOrg: true,
          label,
        })),
      )
      .returning({ id: integrationConnections.id });
    const reads = [
      await read(actor, { [integrationId]: [deleted!.id] }),
      await read(actor, { [integrationId]: [unshared!.id] }),
    ];

    await deleteIntegrationConnection(scope, deleted!.id, { type: "user", id: member.user.id });
    await updateConnectionMetadata(unshared!.id, { sharedWithOrg: false });

    for (const created of reads) {
      await expect(
        updateSchedule(scope, created, { name: "renamed" }, null, undefined),
      ).rejects.toMatchObject(refusedAsStale);
    }
  });

  it("the actor leaving the organization, which disables the schedule, makes the read stale", async () => {
    const member = await memberContext(ctx, "member");
    const created = await read({ type: "user", id: member.user.id });

    await leaveOrganization(ctx.orgId, member.user.id);

    await expect(
      updateSchedule(scope, created, { name: "renamed" }, null, undefined),
    ).rejects.toMatchObject(refusedAsStale);
    const [row] = await db.select().from(schedules).where(eq(schedules.id, created.id));
    expect(row).toMatchObject({ enabled: false, disabledReason: "actor_left_org", name: null });
  });
});

// Plain `describe`: pure SQL on the row, so every tier runs it.
describe("schedule disabled_reason", () => {
  let scope: SpaceScope;
  let actor: Actor;
  let packageId: string;

  beforeEach(async () => {
    await truncateAll();
    const ctx = await createTestContext({ orgSlug: "reasonorg" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    actor = { type: "user", id: ctx.user.id };
    packageId = (await seedPackage({ orgId: ctx.orgId, id: "@reasonorg/agent" })).id;
  });

  const create = () => createSchedule(scope, packageId, actor, { cronExpression: "0 * * * *" });

  it("a person's pause records no reason", async () => {
    const paused = await updateSchedule(scope, await create(), { enabled: false }, null, undefined);
    expect(paused).toMatchObject({ enabled: false, disabled_reason: null });
  });

  it("keeps a system disable's reason until a write re-enables the schedule", async () => {
    const created = await create();
    const [row] = await db
      .update(schedules)
      .set({ enabled: false, disabledReason: "connection_deleted", nextRunAt: null })
      .where(eq(schedules.id, created.id))
      .returning();

    const renamed = await updateSchedule(
      scope,
      { ...created, enabled: false, updatedAt: row!.updatedAt.toISOString() },
      { name: "renamed", enabled: false },
      null,
      undefined,
    );
    expect(renamed.disabled_reason).toBe("connection_deleted");
    const resumed = await updateSchedule(scope, renamed, { enabled: true }, null, undefined);
    expect(resumed).toMatchObject({ enabled: true, disabled_reason: null });
  });

  it("a connection delete emptying the schedule's set records `connection_deleted`", async () => {
    const integrationId = "@reasonorg/svc";
    await seedPackage({ orgId: scope.orgId, id: integrationId, type: "integration" });
    const [gone] = await db
      .insert(integrationConnections)
      .values({
        integrationId,
        authKey: "primary",
        accountId: "gone",
        spaceId: scope.spaceId,
        userId: actor.id,
        credentialsEncrypted: "x",
        scopesGranted: [],
        label: "gone",
      })
      .returning({ id: integrationConnections.id });
    const created = await createSchedule(scope, packageId, actor, {
      cronExpression: "0 * * * *",
      connectionOverrides: { [integrationId]: [gone!.id] },
    });

    await deleteIntegrationConnection(scope, gone!.id, actor);

    const [row] = await db.select().from(schedules).where(eq(schedules.id, created.id));
    expect(row).toMatchObject({ enabled: false, disabledReason: "connection_deleted" });
  });

  it("a connection delete on an ALREADY disabled schedule drops the key and records no reason", async () => {
    const integrationId = "@reasonorg/svc";
    await seedPackage({ orgId: scope.orgId, id: integrationId, type: "integration" });
    const [gone] = await db
      .insert(integrationConnections)
      .values({
        integrationId,
        authKey: "primary",
        accountId: "gone",
        spaceId: scope.spaceId,
        userId: actor.id,
        credentialsEncrypted: "x",
        scopesGranted: [],
        label: "gone",
      })
      .returning({ id: integrationConnections.id });
    const created = await createSchedule(scope, packageId, actor, {
      cronExpression: "0 * * * *",
      connectionOverrides: { [integrationId]: [gone!.id] },
    });
    await db
      .update(schedules)
      .set({ enabled: false, nextRunAt: null })
      .where(eq(schedules.id, created.id));

    const { disabledScheduleIds } = await deleteIntegrationConnection(scope, gone!.id, actor);

    expect(disabledScheduleIds).toEqual([]);
    const [row] = await db.select().from(schedules).where(eq(schedules.id, created.id));
    expect(row).toMatchObject({
      enabled: false,
      disabledReason: null,
      connectionOverrides: null,
    });
  });

  it("refuses an enabled row with a reason", async () => {
    const created = await create();
    const caught = await db
      .update(schedules)
      .set({ disabledReason: "actor_invalid" })
      .where(eq(schedules.id, created.id))
      .catch((err: unknown) => err);
    const cause = (caught as { cause?: { message?: string } }).cause;
    expect(String(cause?.message ?? caught)).toContain(
      "package_schedules_enabled_has_no_disabled_reason",
    );
  });
});
