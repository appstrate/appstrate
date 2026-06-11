// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedSchedule, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";

const app = getTestApp();

describe("Schedules API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
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
        userId: ctx.user.id,
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
          cron_expression: "0 9 * * 1-5",
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
          cron_expression: "0 9 * * 1-5",
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
          cron_expression: "0 9 * * 1-5",
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
          cron_expression: "0 9 * * 1-5",
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
          cron_expression: "0 9 * * 1-5",
          name: "Weekday 9am",
          timezone: "Europe/Paris",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.cron_expression).toBe("0 9 * * 1-5");
      expect(body.name).toBe("Weekday 9am");
      expect(body.timezone).toBe("Europe/Paris");
      // Schedule runs as the creating member.
      expect(body.userId).toBe(ctx.user.id);
      // EnrichedSchedule — same serializer as GET /schedules/:id (#657).
      expect(body.actor_type).toBe("user");
      expect(body).toHaveProperty("actor_name");
    });

    it("rejects invalid cron expression", async () => {
      const fid = agentId("bad-cron");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "not-valid-cron",
        }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("connection_overrides shape (flat per-integration map)", () => {
    // Regression guard for the schedule half of the connection-renewal flow.
    // The wire shape is a FLAT `Record<integrationId, connectionId>` matching
    // the run route — `routes/schedules.ts` validates it with
    // `z.record(z.string(), z.string())`. The frontend previously sent the
    // nested `Record<int, Record<authKey, conn>>` shape, which 400'd. These
    // tests pin both directions so a revert to the nested schema fails CI.
    // Connection ids need not resolve to real rows: the route validates the
    // shape only and freezes the map; resolution happens at fire time.

    it("accepts a flat connection_overrides map on create and round-trips it", async () => {
      const fid = agentId("co-create");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, fid);

      const overrides = { "@runorg/svc": "conn_abc123" };
      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "0 9 * * 1-5",
          connection_overrides: overrides,
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.connection_overrides).toEqual(overrides);
    });

    it("rejects the legacy nested connection_overrides shape with 400", async () => {
      const fid = agentId("co-nested");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "0 9 * * 1-5",
          // Old nested shape: integrationId → { authKey → connectionId }.
          connection_overrides: { "@runorg/svc": { primary: "conn_abc123" } },
        }),
      });

      expect(res.status).toBe(400);
    });

    it("updates connection_overrides via PUT and round-trips the flat map", async () => {
      const fid = agentId("co-update");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        cronExpression: "0 * * * *",
        name: "co-sched",
      });

      const overrides = { "@runorg/svc": "conn_xyz789" };
      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ connection_overrides: overrides }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.connection_overrides).toEqual(overrides);
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
        userId: ctx.user.id,
        cronExpression: "0 * * * *",
        name: "Old Name",
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name", cron_expression: "0 12 * * *" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.name).toBe("New Name");
      expect(body.cron_expression).toBe("0 12 * * *");
      // EnrichedSchedule — same serializer as GET /schedules/:id (#657).
      expect(body.actor_type).toBe("user");
      expect(body).toHaveProperty("actor_name");
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
        userId: ctx.user.id,
        cronExpression: "0 * * * *",
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);
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
        userId: ctx.user.id,
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
      expect(body.actor_type).toBe("user");
    });

    it("returns 404 for unknown schedule id", async () => {
      const res = await app.request("/api/schedules/sched_nonexistent", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for schedule belonging to another org", async () => {
      const otherCtx = await createTestContext();
      const fid = `@${otherCtx.org.slug}/other-agent`;
      const agent = await seedAgent({ id: fid, orgId: otherCtx.orgId });
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: otherCtx.orgId,
        applicationId: otherCtx.defaultAppId,
        userId: otherCtx.user.id,
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
        userId: ctx.user.id,
        cronExpression: "0 * * * *",
      });

      // Seed a run linked to this schedule
      await seedRun({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
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
        userId: ctx.user.id,
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

  describe("Authentication", () => {
    it("returns 401 without auth", async () => {
      const res = await app.request("/api/schedules");
      expect(res.status).toBe(401);
    });
  });
});
