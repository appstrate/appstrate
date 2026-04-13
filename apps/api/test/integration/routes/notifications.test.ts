// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedEndUser } from "../../helpers/seed.ts";
import { addOrgMember, createTestUser } from "../../helpers/auth.ts";

const app = getTestApp();

describe("Notifications API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "notiforg" });
  });

  /**
   * Seed an agent and N runs with notifiedAt set (so they count as unread).
   * Returns the agent and the seeded run records.
   */
  async function seedNotifiableRuns(count: number, agentName = "notif-agent") {
    const agent = await seedAgent({
      id: `@notiforg/${agentName}`,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });

    const runRecords = [];
    for (let i = 0; i < count; i++) {
      const run = await seedRun({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
        notifiedAt: new Date(),
      });
      runRecords.push(run);
    }

    return { agent, runs: runRecords };
  }

  // ─── GET /api/notifications/unread-count ───────────────────

  describe("GET /api/notifications/unread-count", () => {
    it("returns 0 when no runs exist", async () => {
      const res = await app.request("/api/notifications/unread-count", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(0);
    });

    it("returns count after seeding notifiable runs", async () => {
      await seedNotifiableRuns(3);

      const res = await app.request("/api/notifications/unread-count", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(3);
    });

    it("does not count runs without notifiedAt", async () => {
      await seedAgent({
        id: "@notiforg/silent-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await seedRun({
        packageId: "@notiforg/silent-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
        // notifiedAt is null by default — should not be counted
      });

      const res = await app.request("/api/notifications/unread-count", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(0);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/notifications/unread-count");
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/notifications/unread-counts-by-agent ──────────

  describe("GET /api/notifications/unread-counts-by-agent", () => {
    it("returns empty counts when no runs exist", async () => {
      const res = await app.request("/api/notifications/unread-counts-by-agent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        counts: Record<string, number>;
      };
      expect(body.counts).toEqual({});
    });

    it("returns counts grouped by agent", async () => {
      await seedNotifiableRuns(2, "agent-a");
      await seedNotifiableRuns(1, "agent-b");

      const res = await app.request("/api/notifications/unread-counts-by-agent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        counts: Record<string, number>;
      };
      expect(body.counts["@notiforg/agent-a"]).toBe(2);
      expect(body.counts["@notiforg/agent-b"]).toBe(1);
    });
  });

  // ─── PUT /api/notifications/read/:runId ──────────────

  describe("PUT /api/notifications/read/:runId", () => {
    it("marks a notifiable run as read", async () => {
      const { runs: runRecords } = await seedNotifiableRuns(1);
      const runId = runRecords[0]!.id;

      const res = await app.request(`/api/notifications/read/${runId}`, {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      // Verify the count dropped
      const countRes = await app.request("/api/notifications/unread-count", {
        headers: authHeaders(ctx),
      });
      const countBody = (await countRes.json()) as { count: number };
      expect(countBody.count).toBe(0);
    });

    it("returns false for non-existent run", async () => {
      const res = await app.request("/api/notifications/read/exec_nonexistent", {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(false);
    });

    it("returns false for run without notifiedAt", async () => {
      await seedAgent({
        id: "@notiforg/no-notif",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      const run = await seedRun({
        packageId: "@notiforg/no-notif",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/notifications/read/${run.id}`, {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(false);
    });
  });

  // ─── PUT /api/notifications/read-all ───────────────────────

  describe("PUT /api/notifications/read-all", () => {
    it("marks all unread notifications as read", async () => {
      await seedNotifiableRuns(3);

      const res = await app.request("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { updated: number };
      expect(body.updated).toBe(3);

      // Verify the count is now 0
      const countRes = await app.request("/api/notifications/unread-count", {
        headers: authHeaders(ctx),
      });
      const countBody = (await countRes.json()) as { count: number };
      expect(countBody.count).toBe(0);
    });

    it("returns 0 when no unread notifications exist", async () => {
      const res = await app.request("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { updated: number };
      expect(body.updated).toBe(0);
    });

    it("does not mark already-read notifications again", async () => {
      await seedAgent({
        id: "@notiforg/already-read",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await seedRun({
        packageId: "@notiforg/already-read",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
        notifiedAt: new Date(),
        readAt: new Date(),
      });

      const res = await app.request("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { updated: number };
      expect(body.updated).toBe(0);
    });
  });

  // ─── GET /api/runs (org runs, ?user=me filter) ──

  describe("GET /api/runs", () => {
    it("returns empty list when no runs exist", async () => {
      const res = await app.request("/api/runs", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runs: unknown[];
        total: number;
      };
      expect(body.runs).toBeArray();
      expect(body.runs).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("returns seeded runs with total count", async () => {
      await seedAgent({
        id: "@notiforg/list-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await seedRun({
        packageId: "@notiforg/list-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@notiforg/list-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "failed",
      });

      const res = await app.request("/api/runs", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runs: { id: string; status: string }[];
        total: number;
      };
      expect(body.runs).toBeArray();
      expect(body.runs).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("returns all org runs including other members by default", async () => {
      const otherUser = await createTestUser();
      await addOrgMember(ctx.orgId, otherUser.id);

      await seedAgent({
        id: "@notiforg/shared-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await seedRun({
        packageId: "@notiforg/shared-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@notiforg/shared-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: otherUser.id,
        status: "success",
      });

      const res = await app.request("/api/runs", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runs: unknown[];
        total: number;
      };
      expect(body.runs).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("filters to current user only with ?user=me", async () => {
      const otherUser = await createTestUser();
      await addOrgMember(ctx.orgId, otherUser.id);

      await seedAgent({
        id: "@notiforg/filter-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await seedRun({
        packageId: "@notiforg/filter-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@notiforg/filter-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: otherUser.id,
        status: "success",
      });

      const res = await app.request("/api/runs?user=me", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runs: { dashboardUserId: string }[];
        total: number;
      };
      expect(body.runs).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.runs[0]!.dashboardUserId).toBe(ctx.user.id);
    });

    it("respects limit parameter", async () => {
      await seedAgent({
        id: "@notiforg/limit-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      for (let i = 0; i < 5; i++) {
        await seedRun({
          packageId: "@notiforg/limit-agent",
          orgId: ctx.orgId,
          applicationId: ctx.defaultAppId,
          dashboardUserId: ctx.user.id,
          status: "success",
        });
      }

      const res = await app.request("/api/runs?limit=2", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runs: unknown[];
        total: number;
      };
      expect(body.runs).toHaveLength(2);
      expect(body.total).toBe(5);
    });

    it("respects offset parameter", async () => {
      await seedAgent({
        id: "@notiforg/offset-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      for (let i = 0; i < 5; i++) {
        await seedRun({
          packageId: "@notiforg/offset-agent",
          orgId: ctx.orgId,
          applicationId: ctx.defaultAppId,
          dashboardUserId: ctx.user.id,
          status: "success",
        });
      }

      const res = await app.request("/api/runs?limit=10&offset=3", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runs: unknown[];
        total: number;
      };
      expect(body.runs).toHaveLength(2);
      expect(body.total).toBe(5);
    });

    it("respects org isolation", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherotherorg" });
      await seedAgent({
        id: "@otherotherorg/secret-agent",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });
      await seedRun({
        packageId: "@otherotherorg/secret-agent",
        orgId: otherCtx.orgId,
        applicationId: otherCtx.defaultAppId,
        dashboardUserId: otherCtx.user.id,
        status: "success",
      });

      // Request from original context should see 0 runs
      const res = await app.request("/api/runs", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runs: unknown[];
        total: number;
      };
      expect(body.runs).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/runs");
      expect(res.status).toBe(401);
    });
  });

  // ─── End-user run notifications ─────────────────────────────

  describe("End-user run notifications", () => {
    it("marks end-user run as read when viewed by org member", async () => {
      await seedAgent({
        id: "@notiforg/eu-notif-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        name: "External User",
      });
      const run = await seedRun({
        packageId: "@notiforg/eu-notif-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        endUserId: eu.id,
        status: "success",
        notifiedAt: new Date(),
      });

      // Org member marks the end-user run as read
      const res = await app.request(`/api/notifications/read/${run.id}`, {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("counts end-user runs in unread count for org members", async () => {
      await seedAgent({
        id: "@notiforg/eu-count-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        name: "EU Count Test",
      });
      await seedRun({
        packageId: "@notiforg/eu-count-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        endUserId: eu.id,
        status: "success",
        notifiedAt: new Date(),
      });

      const res = await app.request("/api/notifications/unread-count", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(1);
    });

    it("mark-all-read includes end-user runs", async () => {
      await seedAgent({
        id: "@notiforg/eu-markall-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        name: "EU MarkAll",
      });
      await seedRun({
        packageId: "@notiforg/eu-markall-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        endUserId: eu.id,
        status: "success",
        notifiedAt: new Date(),
      });
      // Also seed an own-user run
      await seedRun({
        packageId: "@notiforg/eu-markall-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "success",
        notifiedAt: new Date(),
      });

      const markRes = await app.request("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(markRes.status).toBe(200);
      const markBody = (await markRes.json()) as { updated: number };
      expect(markBody.updated).toBe(2);

      // Verify count is now 0
      const countRes = await app.request("/api/notifications/unread-count", {
        headers: authHeaders(ctx),
      });
      const countBody = (await countRes.json()) as { count: number };
      expect(countBody.count).toBe(0);
    });
  });
});
