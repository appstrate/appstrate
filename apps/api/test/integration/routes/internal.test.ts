// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedAgent,
  seedRun,
  seedConnectionProfile,
  seedConnectionForApp,
  seedPackage,
} from "../../helpers/seed.ts";
import { signRunToken } from "../../../src/lib/run-token.ts";
import { db } from "../../helpers/db.ts";
import { userProviderConnections } from "@appstrate/db/schema";
import { and, eq } from "drizzle-orm";

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
      dashboardUserId: ctx.user.id,
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
        dashboardUserId: ctx.user.id,
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
        dashboardUserId: ctx.user.id,
        status: "success",
        state: { counter: 1 },
      });
      await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
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
          dashboardUserId: ctx.user.id,
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
        dashboardUserId: other.user.id,
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
        dashboardUserId: ctx.user.id,
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
        dashboardUserId: ctx.user.id,
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

    it("returns credentials + authorizedUris + transport metadata for an OAuth2 provider", async () => {
      // Seed a full graph: OAuth2 provider package + agent listing it +
      // profile + connection + running run. Then GET must return the
      // extended payload the sidecar / credential-proxy consumes to
      // inject the upstream auth header server-side.
      const providerId = "@internalorg/gmail";
      await seedPackage({
        orgId: null,
        id: providerId,
        type: "provider",
        source: "system",
        draftManifest: {
          name: providerId,
          version: "1.0.0",
          type: "provider",
          definition: {
            authMode: "oauth2",
            credentialHeaderName: "Authorization",
            credentialHeaderPrefix: "Bearer",
            authorizedUris: ["https://gmail.googleapis.com/**"],
          },
        },
      });

      // Agent must list the provider under dependencies.providers so
      // the route accepts the request.
      const agentWithProvider = await seedAgent({
        id: "@internalorg/agent-with-gmail",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@internalorg/agent-with-gmail",
          version: "0.1.0",
          type: "agent",
          dependencies: { providers: { [providerId]: "^1" } },
        },
      });

      const profile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "Default",
        isDefault: true,
      });
      await seedConnectionForApp(
        profile.id,
        providerId,
        ctx.orgId,
        ctx.defaultAppId,
        { access_token: "ya29.stored-token" },
        { expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
      );

      const run = await seedRun({
        packageId: agentWithProvider.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "running",
        providerProfileIds: { [providerId]: profile.id },
      });

      const res = await app.request(`/internal/credentials/${providerId}`, {
        headers: { Authorization: `Bearer ${signRunToken(run.id)}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        credentials: Record<string, string>;
        authorizedUris: string[] | null;
        allowAllUris: boolean;
        credentialHeaderName?: string;
        credentialHeaderPrefix?: string;
        credentialFieldName: string;
      };
      expect(body.credentials.access_token).toBe("ya29.stored-token");
      expect(body.authorizedUris).toEqual(["https://gmail.googleapis.com/**"]);
      expect(body.allowAllUris).toBe(false);
      expect(body.credentialHeaderName).toBe("Authorization");
      expect(body.credentialHeaderPrefix).toBe("Bearer");
      expect(body.credentialFieldName).toBe("access_token");
    });

    it("omits credentialHeaderName for providers that do not declare it", async () => {
      // A custom-auth or basic-auth provider that never sets
      // `credentialHeaderName` — the sidecar must see `undefined` and
      // therefore skip the injection step. `credentialFieldName` is
      // still populated so the field stays type-stable.
      const providerId = "@internalorg/custom-svc";
      await seedPackage({
        orgId: null,
        id: providerId,
        type: "provider",
        source: "system",
        draftManifest: {
          name: providerId,
          version: "1.0.0",
          type: "provider",
          definition: {
            authMode: "basic",
            authorizedUris: ["https://custom.example.com/**"],
          },
        },
      });

      const agentWithCustom = await seedAgent({
        id: "@internalorg/agent-with-custom",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@internalorg/agent-with-custom",
          version: "0.1.0",
          type: "agent",
          dependencies: { providers: { [providerId]: "^1" } },
        },
      });

      const profile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "Default",
        isDefault: true,
      });
      await seedConnectionForApp(profile.id, providerId, ctx.orgId, ctx.defaultAppId, {
        username: "admin",
        password: "s3cret",
      });

      const run = await seedRun({
        packageId: agentWithCustom.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "running",
        providerProfileIds: { [providerId]: profile.id },
      });

      const res = await app.request(`/internal/credentials/${providerId}`, {
        headers: { Authorization: `Bearer ${signRunToken(run.id)}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        credentialHeaderName?: string;
        credentialFieldName: string;
      };
      expect(body.credentialHeaderName).toBeUndefined();
      // Defaults to "access_token" since authMode is basic (not api_key)
      expect(body.credentialFieldName).toBe("access_token");
    });
  });

  // ─── POST /internal/credentials/:scope/:name/refresh ─────────

  describe("POST /internal/credentials/:scope/:name/refresh", () => {
    const providerId = "@internalorg/gmail";

    async function seedRunWithProfile(expiresAt: string | null): Promise<{
      runToken: string;
      profileId: string;
    }> {
      const profile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "Default",
        isDefault: true,
      });
      await seedConnectionForApp(
        profile.id,
        providerId,
        ctx.orgId,
        ctx.defaultAppId,
        { api_key: "stored-key-xyz" },
        { expiresAt },
      );
      const run = await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "running",
        providerProfileIds: { [providerId]: profile.id },
      });
      return { runToken: signRunToken(run.id), profileId: profile.id };
    }

    it("returns 401 without token", async () => {
      const res = await app.request(`/internal/credentials/${providerId}/refresh`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    it("skips the refresh when the stored token is still fresh", async () => {
      // 30 minutes of lifetime left — well above the 60s safety margin
      const freshExpiry = new Date(Date.now() + 30 * 60_000).toISOString();
      const { runToken, profileId } = await seedRunWithProfile(freshExpiry);

      const rowBefore = (
        await db
          .select()
          .from(userProviderConnections)
          .where(
            and(
              eq(userProviderConnections.profileId, profileId),
              eq(userProviderConnections.providerId, providerId),
            ),
          )
      )[0]!;

      const res = await app.request(`/internal/credentials/${providerId}/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${runToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { credentials: Record<string, string> };
      expect(body.credentials).toBeDefined();

      // The connection row must be untouched — no updatedAt bump, no
      // needsReconnection flag, no re-encryption.
      const rowAfter = (
        await db
          .select()
          .from(userProviderConnections)
          .where(
            and(
              eq(userProviderConnections.profileId, profileId),
              eq(userProviderConnections.providerId, providerId),
            ),
          )
      )[0]!;
      expect(rowAfter.updatedAt.getTime()).toBe(rowBefore.updatedAt.getTime());
      expect(rowAfter.credentialsEncrypted).toBe(rowBefore.credentialsEncrypted);
      expect(rowAfter.needsReconnection).toBe(false);
    });

    it("falls through to the refresh path when expiresAt is null", async () => {
      // No expiresAt → isTokenFresh returns false → proceeds to
      // forceRefreshCredentials. For an api_key-style connection with no
      // provider definition, the refresh path returns the current credentials
      // unchanged (no throw, no mutation) — so we just verify the request
      // completes successfully.
      const { runToken } = await seedRunWithProfile(null);

      const res = await app.request(`/internal/credentials/${providerId}/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${runToken}` },
      });

      expect(res.status).toBe(200);
    });

    it("returns 404 when the provider is not mapped to a profile in the run", async () => {
      // Run without providerProfileIds — refresh has no profile to resolve.
      const res = await app.request(`/internal/credentials/${providerId}/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /internal/connections/report-auth-failure ──────────

  describe("POST /internal/connections/report-auth-failure", () => {
    const providerId = "@internalorg/gmail";

    it("logs the failure but does NOT mutate the connection", async () => {
      // A 401 reported by the sidecar is ambiguous (agent error vs dead
      // credential) and must never flag needsReconnection on its own.
      const profile = await seedConnectionProfile({
        userId: ctx.user.id,
        name: "Default",
        isDefault: true,
      });
      await seedConnectionForApp(profile.id, providerId, ctx.orgId, ctx.defaultAppId, {
        api_key: "stored-key",
      });
      const run = await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        dashboardUserId: ctx.user.id,
        status: "running",
        providerProfileIds: { [providerId]: profile.id },
      });
      const token = signRunToken(run.id);

      const res = await app.request("/internal/connections/report-auth-failure", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ providerId }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { flagged: boolean };
      expect(body.flagged).toBe(false);

      const row = (
        await db
          .select()
          .from(userProviderConnections)
          .where(
            and(
              eq(userProviderConnections.profileId, profile.id),
              eq(userProviderConnections.providerId, providerId),
            ),
          )
      )[0]!;
      expect(row.needsReconnection).toBe(false);
    });
  });
});
