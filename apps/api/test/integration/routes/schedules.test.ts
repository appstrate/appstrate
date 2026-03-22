import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedFlow, seedSchedule } from "../../helpers/seed.ts";

const app = getTestApp();

describe("Schedules API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });


  function flowId(name: string) {
    return `@${ctx.org.slug}/${name}`;
  }

  describe("GET /api/schedules", () => {
    it("returns empty list when no schedules exist", async () => {
      const res = await app.request("/api/schedules", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toBeArray();
      expect(body).toHaveLength(0);
    });

    it("returns schedules for the org", async () => {
      const fid = flowId("sched-flow");
      const flow = await seedFlow({ id: fid, orgId: ctx.orgId });
      await seedSchedule({
        packageId: flow.id,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        cronExpression: "0 * * * *",
        name: "Hourly",
      });

      const res = await app.request("/api/schedules", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0].name).toBe("Hourly");
    });
  });

  describe("POST /api/flows/:scope/:name/schedules", () => {
    it("creates a schedule for a flow", async () => {
      const fid = flowId("cron-flow");
      await seedFlow({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request(`/api/flows/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cronExpression: "0 9 * * 1-5",
          name: "Weekday 9am",
          timezone: "Europe/Paris",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.cronExpression).toBe("0 9 * * 1-5");
      expect(body.name).toBe("Weekday 9am");
      expect(body.timezone).toBe("Europe/Paris");
    });

    it("rejects invalid cron expression", async () => {
      const fid = flowId("bad-cron");
      await seedFlow({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request(`/api/flows/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ cronExpression: "not-valid-cron" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/schedules/:id", () => {
    it("updates schedule name and cron", async () => {
      const fid = flowId("upd-flow");
      const flow = await seedFlow({ id: fid, orgId: ctx.orgId });
      const schedule = await seedSchedule({
        packageId: flow.id,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        cronExpression: "0 * * * *",
        name: "Old Name",
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name", cronExpression: "0 12 * * *" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.name).toBe("New Name");
      expect(body.cronExpression).toBe("0 12 * * *");
    });
  });

  describe("DELETE /api/schedules/:id", () => {
    it("deletes a schedule", async () => {
      const fid = flowId("del-flow");
      const flow = await seedFlow({ id: fid, orgId: ctx.orgId });
      const schedule = await seedSchedule({
        packageId: flow.id,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        cronExpression: "0 * * * *",
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("Authentication", () => {
    it("returns 401 without auth", async () => {
      const res = await app.request("/api/schedules");
      expect(res.status).toBe(401);
    });
  });
});
