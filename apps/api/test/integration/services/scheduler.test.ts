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
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizationMembers, runs, schedules } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg, addOrgMember } from "../../helpers/auth.ts";
import { seedPackage, seedSpace, seedEndUser } from "../../helpers/seed.ts";
import type { Actor } from "../../../src/lib/actor.ts";
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
} from "../../../src/services/scheduler.ts";

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
          generationConfigOverride: { temperature: 0, reasoningLevel: "high" },
          modelIdOverride: "model_abc",
          proxyIdOverride: "prx_xyz",
          versionOverride: "1.2.3",
        },
      );

      expect(schedule.generation_config_override).toEqual({
        temperature: 0,
        reasoningLevel: "high",
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

      const schedules = await listSchedules({ orgId: orgId, spaceId: defaultSpaceId }, actor);

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

      const schedules = await listSchedules({ orgId: orgId, spaceId: defaultSpaceId }, actor);
      expect(schedules).toHaveLength(1);
      expect(schedules[0]!.name).toBe("My Schedule");

      const otherSchedules = await listSchedules(
        { orgId: otherOrg.id, spaceId: otherDefaultSpaceId },
        actor,
      );
      expect(otherSchedules).toHaveLength(1);
      expect(otherSchedules[0]!.name).toBe("Other Schedule");
    });

    it("returns an empty array when no schedules exist", async () => {
      const schedules = await listSchedules({ orgId: orgId, spaceId: defaultSpaceId }, actor);
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
      );
      expect(schedules).toHaveLength(1);
      expect(schedules[0]!.name).toBe("Agent 1 Schedule");

      const schedules2 = await listPackageSchedules(
        { orgId: orgId, spaceId: defaultSpaceId },
        pkg2.id,
        actor,
      );
      expect(schedules2).toHaveLength(1);
      expect(schedules2[0]!.name).toBe("Agent 2 Schedule");
    });

    it("returns empty array for package with no schedules", async () => {
      const schedules = await listPackageSchedules(
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
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

      const found = await getSchedule(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("Hourly Run");
      expect(found!.cron_expression).toBe("0 * * * *");
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
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "0 * * * *",
        },
      );

      const updated = await updateSchedule({ orgId: orgId, spaceId: defaultSpaceId }, created.id, {
        cronExpression: "*/5 * * * *",
      });

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

      const updated = await updateSchedule({ orgId: orgId, spaceId: defaultSpaceId }, created.id, {
        name: "Updated Name",
      });

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
          generationConfigOverride: { reasoningLevel: "low" },
          modelIdOverride: "model_init",
          proxyIdOverride: "prx_init",
          versionOverride: "1.0.0",
        },
      );

      // Cron-only update — overrides untouched (undefined leaves them).
      const partialUpdate = await updateSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
        created.id,
        { cronExpression: "*/15 * * * *" },
      );
      expect(partialUpdate!.generation_config_override).toEqual({ reasoningLevel: "low" });
      expect(partialUpdate!.model_id_override).toBe("model_init");
      expect(partialUpdate!.proxy_id_override).toBe("prx_init");
      expect(partialUpdate!.version_override).toBe("1.0.0");

      // Explicit null clears the override (UI's "Inherit" sentinel).
      const cleared = await updateSchedule({ orgId: orgId, spaceId: defaultSpaceId }, created.id, {
        generationConfigOverride: null,
        modelIdOverride: null,
        proxyIdOverride: null,
        versionOverride: null,
      });
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

      const updated = await updateSchedule({ orgId: orgId, spaceId: defaultSpaceId }, created.id, {
        enabled: false,
      });

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

      await updateSchedule({ orgId: orgId, spaceId: defaultSpaceId }, created.id, {
        enabled: false,
      });

      const updated = await updateSchedule({ orgId: orgId, spaceId: defaultSpaceId }, created.id, {
        enabled: true,
      });

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

      const updated = await updateSchedule({ orgId: orgId, spaceId: defaultSpaceId }, created.id, {
        input: { key: "updated", extra: true },
      });

      expect(updated).not.toBeNull();
      expect(updated!.input).toEqual({ key: "updated", extra: true });
    });

    it("returns null for a non-existent ID", async () => {
      const updated = await updateSchedule(
        { orgId: orgId, spaceId: defaultSpaceId },
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
        { orgId: orgId, spaceId: defaultSpaceId },
        packageId,
        actor,
        {
          cronExpression: "0 * * * *",
        },
      );

      const deleted = await deleteSchedule({ orgId: orgId, spaceId: defaultSpaceId }, created.id);
      expect(deleted).toBe(true);

      const found = await getSchedule(created.id);
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

      const remaining = await listSchedules({ orgId: orgId, spaceId: defaultSpaceId }, actor);
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
      await triggerScheduledRun(
        schedule.id,
        packageId,
        actor,
        orgId,
        defaultSpaceId,
        undefined, // input
        {}, // overrides — versionOverride absent → inherit
      );

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
  // scheduled path too (parity with the 412 on the request path).

  describe("triggerScheduledRun integration manifest health (#737)", () => {
    it("fails fast with a visible failed run when a declared integration package is missing", async () => {
      const agent = await seedPackage({
        orgId,
        id: `@${orgSlug}/missing-integration-agent`,
        draftManifest: {
          name: `@${orgSlug}/missing-integration-agent`,
          version: "0.1.0",
          type: "agent",
          description: "Agent declaring a non-existent integration",
          dependencies: { integrations: { "@vendor/does-not-exist": "1.0.0" } },
        },
      });

      const schedule = await createSchedule({ orgId, spaceId: defaultSpaceId }, agent.id, actor, {
        cronExpression: "0 * * * *",
        versionOverride: "draft",
      });

      await triggerScheduledRun(schedule.id, agent.id, actor, orgId, defaultSpaceId, undefined, {
        versionOverride: "draft",
      });

      const failed = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(failed).toHaveLength(1);
      expect(failed[0]!.status).toBe("failed");
      const err = (failed[0]!.error ?? "").toLowerCase();
      expect(err).toContain("no such package");
    });
  });

  // ── triggerScheduledRun — fire-time actor revalidation (CRIT-13) ──
  //
  // The BullMQ job payload freezes the actor at schedule create/update, and a
  // removed member keeps their `user` row (multi-org) — so a job surviving the
  // removeMember queue cleanup would keep firing under the revoked identity.
  // The fire path must revalidate the frozen actor on EVERY fire and, when
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
      // disable) — this simulates the backstop case: a queued job that
      // survived the revocation path and now fires with the frozen actor.
      await db
        .delete(organizationMembers)
        .where(
          and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, member.id)),
        );

      await triggerScheduledRun(
        schedule.id,
        packageId,
        actorM,
        orgId,
        defaultSpaceId,
        undefined,
        {},
      );

      // VISIBLE failed run — never a silent skip, never `success`.
      const fired = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(fired).toHaveLength(1);
      expect(fired[0]!.status).toBe("failed");
      expect((fired[0]!.error ?? "").toLowerCase()).toContain("no longer a member");

      // The schedule is disabled so the revoked identity never fires again.
      const [row] = await db
        .select({ enabled: schedules.enabled, nextRunAt: schedules.nextRunAt })
        .from(schedules)
        .where(eq(schedules.id, schedule.id));
      expect(row!.enabled).toBe(false);
      expect(row!.nextRunAt).toBeNull();
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

      await triggerScheduledRun(
        schedule.id,
        packageId,
        actorEu,
        orgId,
        defaultSpaceId,
        undefined,
        {},
      );

      const fired = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(fired).toHaveLength(1);
      expect(fired[0]!.status).toBe("failed");
      expect((fired[0]!.error ?? "").toLowerCase()).toContain("end-user");

      const [row] = await db
        .select({ enabled: schedules.enabled, nextRunAt: schedules.nextRunAt })
        .from(schedules)
        .where(eq(schedules.id, schedule.id));
      expect(row!.enabled).toBe(false);
      expect(row!.nextRunAt).toBeNull();
    });

    it("a valid member actor does NOT trip the revalidation (control — fails later, not on membership)", async () => {
      // The seeded agent is a never-published draft, so an inheriting
      // schedule fails on version resolution — NOT on actor validity, and the
      // schedule stays ENABLED (revalidation only disables on invalid actor).
      const schedule = await createSchedule({ orgId, spaceId: defaultSpaceId }, packageId, actor, {
        cronExpression: "0 * * * *",
      });

      await triggerScheduledRun(
        schedule.id,
        packageId,
        actor,
        orgId,
        defaultSpaceId,
        undefined,
        {},
      );

      const fired = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
      expect(fired).toHaveLength(1);
      expect((fired[0]!.error ?? "").toLowerCase()).not.toContain("no longer a member");

      const [row] = await db
        .select({ enabled: schedules.enabled })
        .from(schedules)
        .where(eq(schedules.id, schedule.id));
      expect(row!.enabled).toBe(true);
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
    });

    it("does not list a schedule belonging to another space", async () => {
      expect(await listSchedules({ orgId: orgId, spaceId: spaceBId }, actor)).toHaveLength(0);
      // Control: the same org, the owning space — still there.
      expect(await listSchedules({ orgId: orgId, spaceId: defaultSpaceId }, actor)).toHaveLength(1);
    });

    it("does not list a package's schedules from another space", async () => {
      expect(
        await listPackageSchedules({ orgId: orgId, spaceId: spaceBId }, packageId, actor),
      ).toHaveLength(0);
      expect(
        await listPackageSchedules({ orgId: orgId, spaceId: defaultSpaceId }, packageId, actor),
      ).toHaveLength(1);
    });

    it("does not resolve a schedule by id from another space", async () => {
      expect(
        await getSchedule(scheduleIdInA, { orgId: orgId, spaceId: spaceBId }, actor),
      ).toBeNull();
      expect(
        await getSchedule(scheduleIdInA, { orgId: orgId, spaceId: defaultSpaceId }, actor),
      ).not.toBeNull();
    });

    // `updateSchedule` gates on its own `getSchedule(id, scope)` read and
    // returns null on a miss, so the UPDATE's `spaceId` predicate is
    // defence-in-depth BEHIND that read and cannot be reached independently
    // through this function. What this case pins is the caller-visible half:
    // a cross-space update is a null no-op, never a silent success.
    it("reports no update issued from another space, and the row is unchanged", async () => {
      expect(
        await updateSchedule({ orgId: orgId, spaceId: spaceBId }, scheduleIdInA, {
          name: "Hijacked",
        }),
      ).toBeNull();
      const survivor = await getSchedule(
        scheduleIdInA,
        { orgId: orgId, spaceId: defaultSpaceId },
        actor,
      );
      expect(survivor?.name).toBe("Space A Schedule");
    });

    it("reports no delete from another space, and the row survives", async () => {
      expect(await deleteSchedule({ orgId: orgId, spaceId: spaceBId }, scheduleIdInA)).toBe(false);
      expect(
        await getSchedule(scheduleIdInA, { orgId: orgId, spaceId: defaultSpaceId }, actor),
      ).not.toBeNull();
      // Control: the identical call from the OWNING space does delete, so
      // "false + survives" above is the predicate at work, not a broken id.
      expect(await deleteSchedule({ orgId: orgId, spaceId: defaultSpaceId }, scheduleIdInA)).toBe(
        true,
      );
    });
  });
});
