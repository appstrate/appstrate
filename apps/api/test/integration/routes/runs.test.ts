// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedRunLog, seedApplication } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";

const app = getTestApp();

describe("Runs API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "runorg" });
  });

  // ─── POST /api/agents/:scope/:name/run — input validation ──

  describe("POST /api/agents/:scope/:name/run — input validation", () => {
    const inputSchema = {
      type: "object",
      properties: {
        email: { type: "string", description: "User email" },
        count: { type: "number", description: "Optional count" },
      },
      required: ["email"],
    };

    async function seedAgentWithInput() {
      const agent = await seedAgent({
        id: "@runorg/input-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@runorg/input-agent",
          version: "0.1.0",
          type: "agent",
          description: "Agent with required input",
          input: { schema: inputSchema },
        },
        draftContent: "Process the email: {{email}}",
      });
      await installPackage(ctx.defaultAppId, ctx.orgId, "@runorg/input-agent");
      return agent;
    }

    it("returns 400 when required input field is missing", async () => {
      await seedAgentWithInput();

      const res = await app.request("/api/agents/@runorg/input-agent/run", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { count: 5 } }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("email");
    });

    it("returns 400 when input is omitted entirely and schema has required fields", async () => {
      await seedAgentWithInput();

      const res = await app.request("/api/agents/@runorg/input-agent/run", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when required field is empty string", async () => {
      await seedAgentWithInput();

      const res = await app.request("/api/agents/@runorg/input-agent/run", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { email: "" } }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when required field is null", async () => {
      await seedAgentWithInput();

      const res = await app.request("/api/agents/@runorg/input-agent/run", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { email: null } }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ─── GET /api/agents/:scope/:name/runs ─────────────────────

  describe("GET /api/agents/:scope/:name/runs", () => {
    it("returns empty array when no runs exist", async () => {
      await seedAgent({ id: "@runorg/my-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage(ctx.defaultAppId, ctx.orgId, "@runorg/my-agent");

      const res = await app.request("/api/agents/@runorg/my-agent/runs", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.runs).toBeArray();
      expect(body.runs).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("returns runs for an agent", async () => {
      await seedAgent({ id: "@runorg/my-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage(ctx.defaultAppId, ctx.orgId, "@runorg/my-agent");
      const run = await seedRun({
        packageId: "@runorg/my-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request("/api/agents/@runorg/my-agent/runs", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.runs.length).toBeGreaterThanOrEqual(1);
      const found = body.runs.find((e: { id: string }) => e.id === run.id);
      expect(found).toBeDefined();
    });

    it("respects org isolation", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedAgent({ id: "@otherorg/secret-agent", orgId: otherCtx.orgId });
      await seedRun({
        packageId: "@otherorg/secret-agent",
        orgId: otherCtx.orgId,
        applicationId: otherCtx.defaultAppId,
        userId: otherCtx.user.id,
        status: "success",
      });

      // The agent does not belong to testorg, so requireAgent() should 404
      const res = await app.request("/api/agents/@otherorg/secret-agent/runs", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/agents/@runorg/my-agent/runs");
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/runs/:id ─────────────────────────────────────

  describe("GET /api/runs/:id", () => {
    it("returns run detail", async () => {
      await seedAgent({ id: "@runorg/detail-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/detail-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(run.id);
      expect(body.status).toBe("success");
    });

    it("returns 404 for non-existent run", async () => {
      const res = await app.request("/api/runs/exec_nonexistent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for run from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedAgent({ id: "@otherorg/other-agent", orgId: otherCtx.orgId });
      const run = await seedRun({
        packageId: "@otherorg/other-agent",
        orgId: otherCtx.orgId,
        applicationId: otherCtx.defaultAppId,
        userId: otherCtx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/runs/exec_anything");
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/runs/:id/logs ────────────────────────────────

  describe("GET /api/runs/:id/logs", () => {
    it("returns run logs", async () => {
      await seedAgent({ id: "@runorg/log-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/log-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedRunLog({
        runId: run.id,
        orgId: ctx.orgId,
        message: "Step 1 completed",
        level: "info",
      });
      await seedRunLog({
        runId: run.id,
        orgId: ctx.orgId,
        message: "Step 2 completed",
        level: "info",
      });

      const res = await app.request(`/api/runs/${run.id}/logs`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toBeArray();
      expect(body.length).toBeGreaterThanOrEqual(2);
    });

    it("returns empty array when no logs exist", async () => {
      await seedAgent({ id: "@runorg/nolog-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/nolog-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "pending",
      });

      const res = await app.request(`/api/runs/${run.id}/logs`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toBeArray();
      expect(body).toHaveLength(0);
    });

    it("returns 404 for run from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedAgent({ id: "@otherorg/log-agent", orgId: otherCtx.orgId });
      const run = await seedRun({
        packageId: "@otherorg/log-agent",
        orgId: otherCtx.orgId,
        applicationId: otherCtx.defaultAppId,
        userId: otherCtx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}/logs`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/runs/exec_anything/logs");
      expect(res.status).toBe(401);
    });
  });

  // ─── POST /api/runs/:id/cancel ─────────────────────────────

  describe("POST /api/runs/:id/cancel", () => {
    it("cancels a running run", async () => {
      await seedAgent({ id: "@runorg/cancel-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/cancel-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });

      const res = await app.request(`/api/runs/${run.id}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
    });

    it("cancels a pending run", async () => {
      await seedAgent({ id: "@runorg/cancel-pending", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/cancel-pending",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "pending",
      });

      const res = await app.request(`/api/runs/${run.id}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
    });

    it("returns 409 for non-running run", async () => {
      await seedAgent({ id: "@runorg/done-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/done-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(409);
    });

    it("returns 404 for non-existent run", async () => {
      const res = await app.request("/api/runs/exec_nonexistent/cancel", {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for run from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedAgent({ id: "@otherorg/cancel-agent", orgId: otherCtx.orgId });
      const run = await seedRun({
        packageId: "@otherorg/cancel-agent",
        orgId: otherCtx.orgId,
        applicationId: otherCtx.defaultAppId,
        userId: otherCtx.user.id,
        status: "running",
      });

      const res = await app.request(`/api/runs/${run.id}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/runs/exec_anything/cancel", {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── DELETE /api/agents/:scope/:name/runs ──────────────────

  describe("DELETE /api/agents/:scope/:name/runs", () => {
    it("deletes all runs for an agent (admin)", async () => {
      await seedAgent({ id: "@runorg/del-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage(ctx.defaultAppId, ctx.orgId, "@runorg/del-agent");
      await seedRun({
        packageId: "@runorg/del-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@runorg/del-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "failed",
      });

      const res = await app.request("/api/agents/@runorg/del-agent/runs", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.deleted).toBeGreaterThanOrEqual(2);
    });

    it("returns 409 when running runs exist", async () => {
      await seedAgent({ id: "@runorg/running-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage(ctx.defaultAppId, ctx.orgId, "@runorg/running-agent");
      await seedRun({
        packageId: "@runorg/running-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });

      const res = await app.request("/api/agents/@runorg/running-agent/runs", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(409);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/agents/@runorg/any-agent/runs", {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });

    it("only deletes runs in the current application (cross-app isolation)", async () => {
      // Create a second app
      const appB = await seedApplication({ orgId: ctx.orgId, name: "AppB" });

      await seedAgent({ id: "@runorg/iso-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage(ctx.defaultAppId, ctx.orgId, "@runorg/iso-agent");
      await installPackage(appB.id, ctx.orgId, "@runorg/iso-agent");

      // Seed runs in AppA
      await seedRun({
        packageId: "@runorg/iso-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      // Seed runs in AppB
      const appBRun = await seedRun({
        packageId: "@runorg/iso-agent",
        orgId: ctx.orgId,
        applicationId: appB.id,
        userId: ctx.user.id,
        status: "success",
      });

      // Delete from AppA context
      const res = await app.request("/api/agents/@runorg/iso-agent/runs", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.deleted).toBe(1);

      // AppB run should still exist
      const appBHeaders = {
        ...authHeaders(ctx),
        "X-App-Id": appB.id,
      };
      const listRes = await app.request("/api/agents/@runorg/iso-agent/runs", {
        headers: appBHeaders,
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as any;
      const runIds = listBody.runs.map((r: any) => r.id);
      expect(runIds).toContain(appBRun.id);
    });
  });
});
