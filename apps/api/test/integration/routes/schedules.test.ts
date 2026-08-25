// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedAgent,
  seedSchedule,
  seedRun,
  seedEndUser,
  seedOrgModel,
  seedOrgModelProviderOAuth,
} from "../../helpers/seed.ts";
import { publishAndInstall, seedDivergedAgent } from "../../helpers/schedule-fixtures.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { schedulesPaths } from "../../../src/openapi/paths/schedules.ts";
import { responses } from "../../../src/openapi/responses.ts";

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

  /**
   * Publish a seeded agent's draft and install it — what every schedule
   * fixture on a WRITE route needs. Both write routes now validate against the
   * manifest the schedule will fire, which with no `version_override` is the
   * published one, so a draft-only agent 404s `no_published_version` at the
   * write instead of at every tick. Read/delete fixtures are unaffected and
   * deliberately do not publish.
   */
  async function publish(id: string) {
    await publishAndInstall({
      id,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
    });
  }

  describe("GET /api/schedules", () => {
    it("returns empty list when no schedules exist", async () => {
      const res = await app.request("/api/schedules", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.object).toBe("list");
      expect(body.data).toBeArray();
      expect(body.data).toHaveLength(0);
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
      expect(body.object).toBe("list");
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data[0].name).toBe("Hourly");
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
      await publish(fid);
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

    /**
     * The create route refuses a bad input "at this write rather than silently
     * each tick". PUT had adopted only the locked-field half of that rule, so
     * it answered 200 and the schedule then failed at EVERY fire — visible
     * only in the schedule's own failure record.
     */
    it("refuses a PUT that replaces input with a value the schema rejects", async () => {
      await seedAgentWithInput();
      const fid = agentId("input-sched");

      const created = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "0 9 * * 1-5",
          input: { email: "test@example.com" },
        }),
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as any;

      const res = await app.request(`/api/schedules/${id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { note: "no email at all" } }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).toContain("email");
    });

    it("accepts a PUT whose replacement input still satisfies the schema", async () => {
      await seedAgentWithInput();
      const fid = agentId("input-sched");

      const created = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "0 9 * * 1-5",
          input: { email: "test@example.com" },
        }),
      });
      const { id } = (await created.json()) as any;

      const res = await app.request(`/api/schedules/${id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { email: "other@example.com" } }),
      });

      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/agents/:scope/:name/schedules", () => {
    it("creates a schedule for an agent", async () => {
      const fid = agentId("cron-agent");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);

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
      await publish(fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "not-valid-cron",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects generation settings unsupported by the overridden model", async () => {
      const fid = agentId("unsupported-generation");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);
      const credential = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: "codex",
      });
      const model = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: credential.id,
        modelId: "gpt-5.6-luna",
      });

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "0 9 * * *",
          model_id_override: model.id,
          generation_config_override: { temperature: 0.4 },
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "invalid_request",
        param: "generation_config_override",
      });
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
      await publish(fid);

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
      await publish(fid);

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
      await publish(fid);
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
      await publish(fid);
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

    it("reconciles the generation override when the model changes", async () => {
      const fid = agentId("reconcile-generation");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId });
      await publish(fid);
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        generationConfigOverride: { temperature: 0.7 },
      });
      const credential = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: "codex",
      });
      const model = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: credential.id,
        modelId: "gpt-5.6-luna",
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ model_id_override: model.id }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ generation_config_override: {} });
    });
  });

  describe("actor selection (#738)", () => {
    it("creates a schedule pinned to another org member", async () => {
      const fid = agentId("actor-member");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);
      const other = await createTestUser();
      await addOrgMember(ctx.orgId, other.id, "member");

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "0 9 * * *",
          actor: { user_id: other.id },
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.userId).toBe(other.id);
      expect(body.endUserId).toBeNull();
      expect(body.actor_type).toBe("user");
    });

    it("creates a schedule pinned to an end-user", async () => {
      const fid = agentId("actor-eu");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        externalId: `ext-${Date.now()}`,
        name: "End User",
      });

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "0 9 * * *",
          actor: { end_user_id: eu.id },
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.endUserId).toBe(eu.id);
      expect(body.userId).toBeNull();
      expect(body.actor_type).toBe("end_user");
    });

    it("defaults the actor to the caller when omitted", async () => {
      const fid = agentId("actor-default");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ cron_expression: "0 9 * * *" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.userId).toBe(ctx.user.id);
    });

    it("rejects a user_id that is not an org member", async () => {
      const fid = agentId("actor-foreign");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);
      const stranger = await createTestUser();

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "0 9 * * *",
          actor: { user_id: stranger.id },
        }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects an unknown end_user_id with 400 (not 404)", async () => {
      const fid = agentId("actor-bad-eu");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "0 9 * * *",
          actor: { end_user_id: "eu_does_not_exist" },
        }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects an empty actor object with 400", async () => {
      const fid = agentId("actor-empty");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ cron_expression: "0 9 * * *", actor: {} }),
      });

      expect(res.status).toBe(400);
    });

    it("keeps connection_overrides when the actor is unchanged on update", async () => {
      const fid = agentId("actor-same");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId });
      await publish(fid);
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        cronExpression: "0 * * * *",
        connectionOverrides: { "@acme/slack": "conn_keep" },
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        // Same actor as the existing one → not a change → overrides preserved.
        body: JSON.stringify({ actor: { user_id: ctx.user.id } }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.userId).toBe(ctx.user.id);
      expect(body.connection_overrides).toEqual({ "@acme/slack": "conn_keep" });
    });

    it("rejects both user_id and end_user_id together", async () => {
      const fid = agentId("actor-both");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          cron_expression: "0 9 * * *",
          actor: { user_id: ctx.user.id, end_user_id: "eu_x" },
        }),
      });

      expect(res.status).toBe(400);
    });

    it("re-points the actor on update and resets connection_overrides", async () => {
      const fid = agentId("actor-upd");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId });
      await publish(fid);
      const other = await createTestUser();
      await addOrgMember(ctx.orgId, other.id, "member");
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        cronExpression: "0 * * * *",
        connectionOverrides: { "@acme/slack": "conn_old" },
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ actor: { user_id: other.id } }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.userId).toBe(other.id);
      expect(body.connection_overrides).toBeNull();
    });

    it("leaves the actor untouched when update omits it", async () => {
      const fid = agentId("actor-keep");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId });
      await publish(fid);
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        cronExpression: "0 * * * *",
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.userId).toBe(ctx.user.id);
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
      // Pinned text: the read and write routes share one 404 through
      // `loadScheduleOr404`, and this is the wording all three answer.
      const body = (await res.json()) as { detail: string };
      expect(body.detail).toBe("Schedule 'sched_nonexistent' not found");
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

  // ───────────────────────────────────────────────────────────────────────
  // The manifest a schedule is validated against
  // ───────────────────────────────────────────────────────────────────────

  /**
   * A schedule fires `resolveAgentRunVersion(agent, version_override)`, and
   * with no override that means the PUBLISHED version — never the editor's
   * working copy. `getPackage()` hands the routes `packages.draft_manifest`,
   * so the write routes used to validate a definition the schedule will never
   * execute; every disagreement between the two became a 201 followed by a
   * permanent, silent failure at every tick.
   *
   * The fixtures here deliberately make draft and published DISAGREE. Without
   * that they are byte-identical and the assertions below pass whichever
   * manifest the route happens to read.
   */
  describe("validates against the manifest it will fire, not the draft", () => {
    const REQUIRES_EMAIL = {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
    };
    const REQUIRES_NOTHING = {
      type: "object",
      properties: { note: { type: "string" } },
    };
    const FILE_FIELD = {
      type: "object",
      properties: {
        doc: { type: "string", format: "uri", contentMediaType: "application/pdf" },
      },
    };

    function manifest(id: string, inputSchema: Record<string, unknown>) {
      return {
        name: id,
        version: "1.0.0",
        type: "agent",
        description: "Divergence fixture",
        input: { schema: inputSchema },
      };
    }

    async function diverge(
      name: string,
      published: Record<string, unknown>,
      draft: Record<string, unknown>,
    ) {
      const fid = agentId(name);
      await seedDivergedAgent({
        id: fid,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        published: manifest(fid, published),
        draft: manifest(fid, draft),
      });
      return fid;
    }

    function post(fid: string, body: Record<string, unknown>) {
      return app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ cron_expression: "0 9 * * *", ...body }),
      });
    }

    it("refuses input the PUBLISHED schema rejects, even when the draft accepts it", async () => {
      const fid = await diverge("pub-strict", REQUIRES_EMAIL, REQUIRES_NOTHING);

      const res = await post(fid, { input: { note: "hi" } });

      // Pre-fix this was 201, and then `failSchedule` on every single tick.
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).toContain("email");
    });

    it("accepts input the PUBLISHED schema allows, even when the draft rejects it", async () => {
      const fid = await diverge("draft-strict", REQUIRES_NOTHING, REQUIRES_EMAIL);

      const res = await post(fid, { input: { note: "hi" } });

      expect(res.status).toBe(201);
    });

    it("honours version_override when choosing which manifest to validate", async () => {
      const fid = await diverge("override-draft", REQUIRES_EMAIL, REQUIRES_NOTHING);

      // Pinned to the working copy, which does not require `email`.
      const pinned = await post(fid, { version_override: "draft", input: { note: "hi" } });
      expect(pinned.status).toBe(201);

      // …and the same body against the default (published) selector is refused.
      const inherited = await post(fid, { input: { note: "hi" } });
      expect(inherited.status).toBe(400);
    });

    it("refuses an agent whose PUBLISHED schema has a file field", async () => {
      const fid = await diverge("pub-file", FILE_FIELD, REQUIRES_NOTHING);

      const res = await post(fid, {});

      // The refusal this route exists for, applied to the manifest that runs.
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("file inputs");
    });

    it("404s a never-published agent at the write, exactly as POST …/run does", async () => {
      const fid = agentId("never-published");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, fid);

      const res = await post(fid, {});

      // Pre-fix: 201, then a 404 `no_published_version` on every fire — a
      // schedule that could never run, with the 201 as its only receipt.
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.code).toBe("no_published_version");

      // …while pinning the working copy explicitly is still legal: the refusal
      // is about the DEFAULT selector, not about drafts.
      const pinned = await post(fid, { version_override: "draft" });
      expect(pinned.status).toBe(201);
    });

    it("declares that 404 in the OpenAPI spec — on BOTH write operations", () => {
      // The spec is the published contract for these endpoints; a status only
      // the implementation knows about is a client that cannot handle it.
      //
      // Iterated, not hard-coded to the create path. The gate applies to both
      // writes (`assertScheduleTargetValid` runs on POST and PUT alike), and the
      // first version of this test read `.post` alone — so `PUT` kept declaring
      // the generic `NotFound` while answering `no_published_version`, and this
      // test reported green over exactly the gap it was written to close.
      const paths = schedulesPaths as Record<string, any>;
      const writes: Array<[string, any]> = [
        [
          "POST /api/agents/{scope}/{name}/schedules",
          paths["/api/agents/{scope}/{name}/schedules"].post,
        ],
        ["PUT /api/schedules/{id}", paths["/api/schedules/{id}"].put],
      ];

      // Positive control: two operations, both real. A typo in either key would
      // otherwise make this loop assert nothing.
      expect(writes.every(([, op]) => op !== undefined)).toBe(true);

      for (const [label, op] of writes) {
        expect(Object.keys(op.responses), label).toContain("404");
        // The SAME component on both, which is what stops them drifting apart
        // again: an inline description on one is a second source of truth.
        expect(op.responses["404"], label).toEqual({
          $ref: "#/components/responses/NoPublishedVersion",
        });
        // …and the cause the invalid-timezone refusal answers with, which POST
        // never declared either.
        expect(op.responses["400"].description, label).toContain("timezone");
      }

      // The component the two `$ref`s resolve to actually names the code.
      expect(responses.NoPublishedVersion.description).toContain("no_published_version");
    });

    it("applies the same manifest choice on PUT", async () => {
      const fid = await diverge("put-pub-strict", REQUIRES_EMAIL, REQUIRES_NOTHING);

      const created = await post(fid, { input: { email: "a@example.com" } });
      expect(created.status).toBe(201);
      const scheduleId = ((await created.json()) as any).id as string;

      const res = await app.request(`/api/schedules/${scheduleId}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { note: "hi" } }),
      });

      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("email");
    });

    /**
     * The gate resolves the manifest the schedule will FIRE, so on a
     * never-published agent it 404s. Rows like that exist — POST accepted them
     * before the gate did — and a patch that cannot change what the schedule
     * fires must stay applicable to them, or the only remaining way to stop a
     * misfiring legacy schedule is to delete it (DELETE never resolved a
     * manifest and still answers 204).
     */
    describe("a legacy schedule on a never-published agent", () => {
      async function seedLegacy(name: string): Promise<string> {
        const fid = agentId(name);
        const agent = await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
        await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, fid);
        const schedule = await seedSchedule({
          packageId: agent.id,
          orgId: ctx.orgId,
          applicationId: ctx.defaultAppId,
          userId: ctx.user.id,
          cronExpression: "0 * * * *",
          name: "Legacy",
        });
        return schedule.id;
      }

      function put(scheduleId: string, body: Record<string, unknown>) {
        return app.request(`/api/schedules/${scheduleId}`, {
          method: "PUT",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      it("can still be disabled", async () => {
        const scheduleId = await seedLegacy("legacy-disable");

        const res = await put(scheduleId, { enabled: false });

        expect(res.status).toBe(200);
        expect(((await res.json()) as any).enabled).toBe(false);
      });

      it("can still be renamed and rescheduled", async () => {
        const scheduleId = await seedLegacy("legacy-rename");

        const res = await put(scheduleId, { name: "Renamed", cron_expression: "0 6 * * *" });

        expect(res.status).toBe(200);
      });

      it("still 404s when the patch moves what it would fire", async () => {
        const scheduleId = await seedLegacy("legacy-input");

        // `input` feeds the manifest decision, so this patch has to prove the
        // target is firable — and it is not.
        const res = await put(scheduleId, { input: { note: "hi" } });

        expect(res.status).toBe(404);
        expect(((await res.json()) as any).code).toBe("no_published_version");
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // timezone
  // ───────────────────────────────────────────────────────────────────────

  /**
   * An unknown IANA zone is silent all the way down: `CronExpressionParser`
   * accepts it and only `.next()` throws, which `computeNextRun` swallows into
   * `null` and BullMQ's `getNextMillis` swallows into `undefined` — so the row
   * is written with `next_run_at = NULL` and NO repeat job is registered. The
   * API answered `201 { enabled: true }` for a schedule that could never fire:
   * no log line, no failed run, no `failSchedule`.
   */
  describe("timezone is refused at the write", () => {
    it("rejects an unknown zone with 400 on create", async () => {
      const fid = agentId("tz-create");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ cron_expression: "0 9 * * *", timezone: "Europe/Pariss" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.param).toBe("timezone");
    });

    it("accepts a real zone and actually schedules it (control)", async () => {
      const fid = agentId("tz-ok");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ cron_expression: "0 9 * * *", timezone: "Europe/Paris" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      // The assertion that separates "accepted" from "will actually fire" —
      // the rejected zone above is exactly the case that lands a NULL here.
      expect(body.next_run_at).not.toBeNull();
    });

    it("rejects an unknown zone with 400 on update", async () => {
      const fid = agentId("tz-update");
      const agent = await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);
      const schedule = await seedSchedule({
        packageId: agent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        cronExpression: "0 * * * *",
      });

      const res = await app.request(`/api/schedules/${schedule.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "Not/AZone" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.param).toBe("timezone");
    });

    it("still blames cron_expression for a bad expression (control)", async () => {
      const fid = agentId("tz-bad-cron");
      await seedAgent({ id: fid, orgId: ctx.orgId, createdBy: ctx.user.id });
      await publish(fid);

      const res = await app.request(`/api/agents/${fid}/schedules`, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ cron_expression: "not-valid-cron", timezone: "Europe/Paris" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.param).toBe("cron_expression");
    });
  });

  describe("Authentication", () => {
    it("returns 401 without auth", async () => {
      const res = await app.request("/api/schedules");
      expect(res.status).toBe(401);
    });
  });
});
