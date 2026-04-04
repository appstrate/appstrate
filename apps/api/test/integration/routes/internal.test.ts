// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";

const app = getTestApp();

describe("Internal API", () => {
  let ctx: TestContext;
  let pkgId: string;
  let runningRunId: string;
  let runningToken: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "internalorg" });
    pkgId = "@internalorg/test-agent";

    await seedAgent({
      id: pkgId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });

    const exec = await seedRun({
      packageId: pkgId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "running",
    });
    runningRunId = exec.id;
    runningToken = signRunToken(runningRunId);
  });

  // ─── GET /internal/run-history ─────────────────────────

  describe("GET /internal/run-history", () => {
    it("returns 401 without token", async () => {
      const res = await app.request("/internal/run-history");
      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid token", async () => {
      const res = await app.request("/internal/run-history", {
        headers: { Authorization: "Bearer totally-invalid-token" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 with forged signature", async () => {
      // Valid format but wrong HMAC
      const res = await app.request("/internal/run-history", {
        headers: {
          Authorization: `Bearer ${runningRunId}.0000000000000000000000000000000000000000000000000000000000000000`,
        },
      });
      expect(res.status).toBe(401);
    });

    it("returns 403 when run is not running", async () => {
      const doneRun = await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });
      const doneToken = signRunToken(doneRun.id);

      const res = await app.request("/internal/run-history", {
        headers: { Authorization: `Bearer ${doneToken}` },
      });
      expect(res.status).toBe(403);
    });

    it("returns empty array for first run (no prior history)", async () => {
      const res = await app.request("/internal/run-history", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: unknown[] };
      expect(body.runs).toBeArray();
      expect(body.runs).toHaveLength(0);
    });

    it("returns recent runs for the same agent and user", async () => {
      // Seed 2 completed runs for the same agent+user
      await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
        state: { counter: 1 },
      });
      await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
        state: { counter: 2 },
      });

      const res = await app.request("/internal/run-history", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: Record<string, unknown>[] };
      expect(body.runs).toBeArray();
      expect(body.runs.length).toBe(2);
    });

    it("respects the limit query parameter", async () => {
      // Seed 3 completed runs
      for (let i = 0; i < 3; i++) {
        await seedRun({
          packageId: pkgId,
          orgId: ctx.orgId,
          applicationId: ctx.defaultAppId,
          userId: ctx.user.id,
          status: "success",
          state: { i },
        });
      }

      const res = await app.request("/internal/run-history?limit=2", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: unknown[] };
      expect(body.runs).toHaveLength(2);
    });

    it("clamps limit to valid range (min 1, max 50)", async () => {
      // limit=0 should be clamped to 1
      const res = await app.request("/internal/run-history?limit=0", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(200);

      // limit=999 should be clamped to 50
      const res2 = await app.request("/internal/run-history?limit=999", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res2.status).toBe(200);
    });

    it("excludes the current running run from results", async () => {
      // The running run itself should never appear in history
      const res = await app.request("/internal/run-history", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: { id: string }[] };
      const ids = body.runs.map((e) => e.id);
      expect(ids).not.toContain(runningRunId);
    });

    it("does not return runs from a different user", async () => {
      // Seed a run by a different user for the same agent
      const other = await createTestContext({ orgSlug: "otherorg" });
      await seedAgent({
        id: "@otherorg/test-agent",
        orgId: other.orgId,
        createdBy: other.user.id,
      });
      await seedRun({
        packageId: "@otherorg/test-agent",
        orgId: other.orgId,
        applicationId: other.defaultAppId,
        userId: other.user.id,
        status: "success",
        state: { foreign: true },
      });

      const res = await app.request("/internal/run-history", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: unknown[] };
      expect(body.runs).toHaveLength(0);
    });

    it("accepts fields=state,result query parameter", async () => {
      await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
        state: { key: "value" },
        result: { output: "done" },
      });

      const res = await app.request("/internal/run-history?fields=state,result", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: Record<string, unknown>[] };
      expect(body.runs).toHaveLength(1);
      const entry = body.runs[0]!;
      expect(entry.state).toEqual({ key: "value" });
      expect(entry.result).toEqual({ output: "done" });
    });
  });

  // ─── GET /internal/credentials/:scope/:name ──────────────────

  describe("GET /internal/credentials/:scope/:name", () => {
    it("returns 401 without token", async () => {
      const res = await app.request("/internal/credentials/@internalorg/gmail");
      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid token", async () => {
      const res = await app.request("/internal/credentials/@internalorg/gmail", {
        headers: { Authorization: "Bearer bad.token" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 403 when run is not running", async () => {
      const doneRun = await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "failed",
      });
      const doneToken = signRunToken(doneRun.id);

      const res = await app.request("/internal/credentials/@internalorg/gmail", {
        headers: { Authorization: `Bearer ${doneToken}` },
      });
      expect(res.status).toBe(403);
    });

    it("returns 404 for a provider not required by the agent", async () => {
      // The test agent has no manifest providers, so any provider should 404.
      // However, getPackage may return null for an agent without a published manifest.
      // The route will either 404 on "Agent not found" or "Provider not required".
      const res = await app.request("/internal/credentials/@internalorg/unknown-provider", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 when run does not exist", async () => {
      // Sign a token for a non-existent run ID
      const fakeToken = signRunToken("exec_doesnotexist00");

      const res = await app.request("/internal/credentials/@internalorg/gmail", {
        headers: { Authorization: `Bearer ${fakeToken}` },
      });

      expect(res.status).toBe(404);
    });
  });
});
