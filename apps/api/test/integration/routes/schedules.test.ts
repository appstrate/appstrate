// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedSchedule, seedConnectionProfile, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";

const app = getTestApp();

describe("Schedules API", () => {
  let ctx: TestContext;
  let profileId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    const profile = await seedConnectionProfile({ userId: ctx.user.id, name: "Default" });
    profileId = profile.id;
  });

  function agentId(name: string) {
    return `@${ctx.org.slug}/${name}`;
  }

  describe("GET /api/schedules", () => {
    it("returns empty list when no schedules exist", async () => {
      const res = await app.request("/api/schedules", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toBeArray();
      expect(body).toHaveLength(0);
    });

    it("returns schedules for the org", async () => {
      const fid = agentId("sched-agent");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId });
      await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        connectionProfileId: profileId,
        cronExpression: "0 * * * *",
        name: "Hourly",
      });

      const res = await app.request("/api/schedules", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0].name).toBe("Hourly");
    });
  });

  describe("POST /api/agents/:scope/:name/schedules — input validation", () => {
    const inputSchema = {
      type: "object",
      properties: {
        email: { type: "string", description: "User email" },
        note: { type: "string", description: "Optional note" },
      },
      required: ["email"],
    };

    async function seedAgentWithInput() {
      const fid = agentId("input-sched");
      const agent = await seedAgent({
        id: fid,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: fid,
          version: "0.1.0",
          type: "agent",
          description: "Agent with required input",
          input: { schema: inputSchema },
        },
        draftContent: "Process {{email}}",
      });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, fid);
      return agent;
    }

    it("returns 400 when required input field is missing", async () => {
      await seedAgentWithInput();
      const fid = agentId("input-sched");

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionProfileId: profileId,
          cronExpression: "0 9 * * 1-5",
          input: { note: "hello" },
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("email");
    });

    it("returns 400 when input is omitted and schema has required fields", async () => {
      await seedAgentWithInput();
      const fid = agentId("input-sched");

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionProfileId: profileId,
          cronExpression: "0 9 * * 1-5",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when required field is empty string", async () => {
      await seedAgentWithInput();
      const fid = agentId("input-sched");

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionProfileId: profileId,
          cronExpression: "0 9 * * 1-5",
          input: { email: "" },
        }),
      });

      expect(res.status).toBe(400);
    });

    it("creates schedule when required input is provided", async () => {
      await seedAgentWithInput();
      const fid = agentId("input-sched");

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionProfileId: profileId,
          cronExpression: "0 9 * * 1-5",
          input: { email: "test@example.com" },
        }),
      });

      expect(res.status).toBe(201);
    });
  });

  describe("POST /api/agents/:scope/:name/schedules", () => {
    it("creates a schedule for an agent", async () => {
      const fid = agentId("cron-agent");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionProfileId: profileId,
          cronExpression: "0 9 * * 1-5",
          name: "Weekday 9am",
          timezone: "Europe/Paris",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.cronExpression).toBe("0 9 * * 1-5");
      expect(body.name).toBe("Weekday 9am");
      expect(body.timezone).toBe("Europe/Paris");
    });

    it("rejects invalid cron expression", async () => {
      const fid = agentId("bad-cron");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connectionProfileId: profileId, cronExpression: "not-valid-cron" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/schedules/:id", () => {
    it("updates schedule name and cron", async () => {
      const fid = agentId("upd-agent");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId });
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        connectionProfileId: profileId,
        cronExpression: "0 * * * *",
        name: "Old Name",
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name", cronExpression: "0 12 * * *" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.name).toBe("New Name");
      expect(body.cronExpression).toBe("0 12 * * *");
    });
  });

  describe("DELETE /api/schedules/:id", () => {
    it("deletes a schedule", async () => {
      const fid = agentId("del-agent");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId });
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        connectionProfileId: profileId,
        cronExpression: "0 * * * *",
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/schedules/:id", () => {
    it("returns a single schedule by id", async () => {
      const fid = agentId("get-sched");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId });
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        connectionProfileId: profileId,
        cronExpression: "0 * * * *",
        name: "Hourly Run",
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(schedule.id);
      expect(body.name).toBe("Hourly Run");
      expect(body.readiness).toBeDefined();
      expect(body.profileName).toBeDefined();
    });

    it("returns 404 for unknown schedule id", async () => {
      const res = await app.request("/api/schedules/sched_nonexistent", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for schedule belonging to another org", async () => {
      const otherCtx = await createTestContext();
      const otherProfile = await seedConnectionProfile({
        userId: otherCtx.user.id,
        name: "Other",
      });
      const fid = `@${otherCtx.org.slug}/other-agent`;
      const agent = await seedAgent({ id: fid, orgId: otherCtx.orgId });
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: otherCtx.orgId,
        applicationId: otherCtx.defaultAppId,
        connectionProfileId: otherProfile.id,
        cronExpression: "0 * * * *",
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/schedules/:id/runs", () => {
    it("returns runs for a schedule", async () => {
      const fid = agentId("exec-sched");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId });
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        connectionProfileId: profileId,
        cronExpression: "0 * * * *",
      });

      // Seed a run linked to this schedule
      await seedRun({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        scheduleId: schedule.id,
        status: "success",
      });

      const res = await app.request(`/api/schedules/${schedule.id}/runs`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data[0].scheduleId).toBe(schedule.id);
      expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it("returns empty array when no runs exist", async () => {
      const fid = agentId("empty-exec");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId });
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        connectionProfileId: profileId,
        cronExpression: "0 * * * *",
      });

      const res = await app.request(`/api/schedules/${schedule.id}/runs`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeArray();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  describe("Org profile support", () => {
    it("creates a schedule with an app profile", async () => {
      const appProfile = await seedConnectionProfile({
        applicationId: ctx.defaultAppId,
        name: "App Profile",
      });
      const fid = agentId("org-sched");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionProfileId: appProfile.id,
          cronExpression: "0 9 * * 1-5",
          name: "App Schedule",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.connectionProfileId).toBe(appProfile.id);
    });

    it("updates a schedule to use an app profile", async () => {
      const appProfile = await seedConnectionProfile({
        applicationId: ctx.defaultAppId,
        name: "App Profile",
      });
      const fid = agentId("org-upd");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId });
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        connectionProfileId: profileId,
        cronExpression: "0 * * * *",
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connectionProfileId: appProfile.id }),
      });

      expect(res.status).toBe(200);
    });

    it("rejects a profile from another org", async () => {
      const otherCtx = await createTestContext();
      const otherAppProfile = await seedConnectionProfile({
        applicationId: otherCtx.defaultAppId,
        name: "Other App Profile",
      });
      const fid = agentId("foreign-org");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionProfileId: otherAppProfile.id,
          cronExpression: "0 9 * * 1-5",
        }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe("Authentication", () => {
    it("returns 401 without auth", async () => {
      const res = await app.request("/api/schedules");
      expect(res.status).toBe(401);
    });
  });
});
