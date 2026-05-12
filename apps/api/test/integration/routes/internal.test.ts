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
  seedEndUser,
  seedOrgModelProviderKey,
} from "../../helpers/seed.ts";
import { modelProviderCredentials } from "@appstrate/db/schema";
import { encryptCredentials } from "@appstrate/connect";
import type { OAuthBlob } from "../../../src/services/model-providers/credentials.ts";
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
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toBeArray();
      expect(body.data).toHaveLength(0);
    });

    it("returns recent runs for the same agent and user", async () => {
      // Seed 2 completed runs for the same agent+user
      await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
        checkpoint: { counter: 1 },
      });
      await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
        checkpoint: { counter: 2 },
      });

      const res = await app.request("/internal/run-history", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown>[] };
      expect(body.data).toBeArray();
      expect(body.data.length).toBe(2);
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
          checkpoint: { i },
        });
      }

      const res = await app.request("/internal/run-history?limit=2", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(2);
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
      const body = (await res.json()) as { data: { id: string }[] };
      const ids = body.data.map((e) => e.id);
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
        checkpoint: { foreign: true },
      });

      const res = await app.request("/internal/run-history", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(0);
    });

    it("accepts fields=checkpoint,result and returns the canonical `checkpoint` key", async () => {
      await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
        checkpoint: { key: "value" },
        result: { output: "done" },
      });

      const res = await app.request("/internal/run-history?fields=checkpoint,result", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown>[] };
      expect(body.data).toHaveLength(1);
      const entry = body.data[0]!;
      expect(entry.checkpoint).toEqual({ key: "value" });
      expect(entry.result).toEqual({ output: "done" });
      // Legacy key never leaks back out — response speaks the new vocabulary.
      expect(entry.state).toBeUndefined();
    });

    it("returns 400 with the valid-fields list when an unknown field is passed", async () => {
      // The legacy AFPS ≤ 1.3 alias `state` is no longer accepted. Failing
      // loudly here is what protects agents whose runtime is stale: the
      // earlier silent-filter behaviour stripped the field and fell back to
      // `["checkpoint"]`, masking the misconfiguration.
      const res = await app.request("/internal/run-history?fields=state", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string; errors?: { field?: string }[] };
      expect(body.detail).toContain("state");
      expect(body.detail).toContain("checkpoint");
      expect(body.detail).toContain("result");
    });

    it("returns 400 when only some fields are valid", async () => {
      const res = await app.request("/internal/run-history?fields=checkpoint,bogus", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string };
      expect(body.detail).toContain("bogus");
    });

    it("treats an empty fields= query as default (`checkpoint` only)", async () => {
      await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
        checkpoint: { key: "v" },
        result: { output: "irrelevant" },
      });

      const res = await app.request("/internal/run-history?fields=", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown>[] };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.checkpoint).toEqual({ key: "v" });
      // No `result` because we defaulted to `checkpoint` only.
      expect(body.data[0]!.result).toBeUndefined();
    });

    it("does not return checkpoints from a different end-user (actor isolation)", async () => {
      // The current `runningToken` belongs to a run triggered by
      // `ctx.user.id` (a dashboard user). Seed a successful end-user
      // run for the SAME agent + SAME app and assert that its
      // checkpoint never appears in the running run's history — the
      // internal endpoint filters by the run's actor.
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        externalId: `ext_${Date.now()}`,
      });
      await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: null,
        endUserId: eu.id,
        status: "success",
        checkpoint: { secret: true },
      });

      const res = await app.request("/internal/run-history?fields=checkpoint", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown>[] };
      // No `secret` checkpoint may leak through — the end-user run is
      // a different actor than the running run's dashboard-user actor.
      for (const r of body.data) {
        const cp = r.checkpoint as Record<string, unknown> | null;
        if (cp) expect(cp.secret).toBeUndefined();
      }
    });
  });

  // ─── GET /internal/memories ─────────────────────────────────

  describe("GET /internal/memories", () => {
    it("returns 401 without token", async () => {
      const res = await app.request("/internal/memories");
      expect(res.status).toBe(401);
    });

    it("returns archive memories visible to the run's actor (most recent first)", async () => {
      const { addMemories } = await import("../../../src/services/state/package-persistence.ts");
      // Two archive memories scoped to the running user's actor.
      await addMemories(
        pkgId,
        ctx.defaultAppId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        ["archived fact A", "archived fact B"],
        runningRunId,
      );

      const res = await app.request("/internal/memories", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        memories: { content: string; createdAt: string }[];
      };
      expect(body.memories).toHaveLength(2);
      // ORDER BY createdAt DESC — most recent first.
      expect(body.memories[0]!.content).toBe("archived fact B");
      expect(body.memories[1]!.content).toBe("archived fact A");
    });

    it("excludes pinned memories — they are already in the prompt", async () => {
      const { addMemories } = await import("../../../src/services/state/package-persistence.ts");
      await addMemories(
        pkgId,
        ctx.defaultAppId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        ["pinned-only"],
        runningRunId,
        { pinned: true },
      );
      await addMemories(
        pkgId,
        ctx.defaultAppId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        ["archive-only"],
        runningRunId,
      );

      const res = await app.request("/internal/memories", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { memories: { content: string }[] };
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0]!.content).toBe("archive-only");
    });

    it("filters by `q` substring (case-insensitive)", async () => {
      const { addMemories } = await import("../../../src/services/state/package-persistence.ts");
      await addMemories(
        pkgId,
        ctx.defaultAppId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        ["User prefers Python", "User likes coffee", "API quirk: 429 on /v1/x"],
        runningRunId,
      );

      const res = await app.request("/internal/memories?q=python", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { memories: { content: string }[] };
      expect(body.memories).toHaveLength(1);
      expect(body.memories[0]!.content).toBe("User prefers Python");
    });

    it("respects the `limit` query (capped at 50)", async () => {
      const { addMemories } = await import("../../../src/services/state/package-persistence.ts");
      const contents = Array.from({ length: 12 }, (_, i) => `mem-${i}`);
      await addMemories(
        pkgId,
        ctx.defaultAppId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        contents,
        runningRunId,
      );

      const res = await app.request("/internal/memories?limit=3", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { memories: unknown[] };
      expect(body.memories).toHaveLength(3);
    });

    it("does not leak across actors — the running user does not see another end-user's archive", async () => {
      const { addMemories } = await import("../../../src/services/state/package-persistence.ts");
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        externalId: `ext_${Date.now()}_recall`,
      });
      await addMemories(
        pkgId,
        ctx.defaultAppId,
        ctx.orgId,
        { type: "end_user", id: eu.id },
        ["secret end-user memory"],
        runningRunId,
      );

      const res = await app.request("/internal/memories", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { memories: { content: string }[] };
      for (const m of body.memories) {
        expect(m.content).not.toBe("secret end-user memory");
      }
    });

    it("returns 400 when `q` exceeds the per-entry content cap", async () => {
      const oversized = "a".repeat(2001);
      const res = await app.request(`/internal/memories?q=${oversized}`, {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(400);
    });

    it("treats an empty `q=` as no filter", async () => {
      const { addMemories } = await import("../../../src/services/state/package-persistence.ts");
      await addMemories(
        pkgId,
        ctx.defaultAppId,
        ctx.orgId,
        { type: "user", id: ctx.user.id },
        ["entry"],
        runningRunId,
      );
      const res = await app.request("/internal/memories?q=", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { memories: unknown[] };
      expect(body.memories).toHaveLength(1);
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
        userId: ctx.user.id,
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
        userId: ctx.user.id,
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

    it("resolves credentials for inline-run shadow (ephemeral) packages", async () => {
      // Inline runs (`POST /api/runs/inline`) insert a shadow agent row
      // with `ephemeral: true`. The default `getPackage()` filter
      // excludes shadows (so public listings don't expose them); the
      // credentials route must opt in via `includeEphemeral: true` or
      // every inline run that calls `provider_call` would 404 with
      // "Agent not found" before the upstream is ever reached.
      const providerId = "@internalorg/inline-gmail";
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

      const shadowAgent = await seedPackage({
        id: "@inline/r-test-shadow",
        orgId: ctx.orgId,
        ephemeral: true,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@inline/r-test-shadow",
          version: "0.0.0",
          type: "agent",
          dependencies: { providers: { [providerId]: "*" } },
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
        { access_token: "ya29.shadow-token" },
        { expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() },
      );

      const run = await seedRun({
        packageId: shadowAgent.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
        providerProfileIds: { [providerId]: profile.id },
      });

      const res = await app.request(`/internal/credentials/${providerId}`, {
        headers: { Authorization: `Bearer ${signRunToken(run.id)}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { credentials: Record<string, string> };
      expect(body.credentials.access_token).toBe("ya29.shadow-token");
    });
  });

  // ─── POST /internal/credentials/:scope/:name/refresh ─────────

  describe("POST /internal/credentials/:scope/:name/refresh", () => {
    const providerId = "@internalorg/gmail";

    async function seedRunWithProfile(expiresAt: string | null): Promise<{
      runToken: string;
      connectionProfileId: string;
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
        userId: ctx.user.id,
        status: "running",
        providerProfileIds: { [providerId]: profile.id },
      });
      return { runToken: signRunToken(run.id), connectionProfileId: profile.id };
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
      const { runToken, connectionProfileId } = await seedRunWithProfile(freshExpiry);

      const rowBefore = (
        await db
          .select()
          .from(userProviderConnections)
          .where(
            and(
              eq(userProviderConnections.connectionProfileId, connectionProfileId),
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
              eq(userProviderConnections.connectionProfileId, connectionProfileId),
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

  // ─── GET /internal/oauth-token/:credentialId ───────────
  //
  // The path param is a `model_provider_credentials.id`. These tests pin
  // that contract so the bug that shipped pre-fix (validation against
  // `userProviderConnections.id`, always 404) cannot reappear.

  describe("GET /internal/oauth-token/:credentialId", () => {
    async function seedOAuthCredential(orgId: string): Promise<string> {
      const blob: OAuthBlob = {
        kind: "oauth",
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: Date.now() + 3600_000,
        needsReconnection: false,
      };
      const [row] = await db
        .insert(modelProviderCredentials)
        .values({
          orgId,
          label: "Test OAuth Credential",
          providerId: "test-oauth",
          credentialsEncrypted: encryptCredentials(blob as unknown as Record<string, unknown>),
          createdBy: null,
        })
        .returning({ id: modelProviderCredentials.id });
      return row!.id;
    }

    it("returns 401 without a run token", async () => {
      const res = await app.request("/internal/oauth-token/some-id");
      expect(res.status).toBe(401);
    });

    it("returns 404 when the credentialId does not exist", async () => {
      const res = await app.request("/internal/oauth-token/00000000-0000-0000-0000-000000000000", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 (not 500) when the credentialId is not a valid UUID", async () => {
      const res = await app.request("/internal/oauth-token/not-a-uuid", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(404);
    });

    it("returns 403 when the credential belongs to another org", async () => {
      const otherOrg = await createTestContext({ orgSlug: "otherorg" });
      const credentialId = await seedOAuthCredential(otherOrg.orgId);

      const res = await app.request(`/internal/oauth-token/${credentialId}`, {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(403);
    });

    it("returns 200 with a resolved token when the credential matches the run org", async () => {
      const credentialId = await seedOAuthCredential(ctx.orgId);

      const res = await app.request(`/internal/oauth-token/${credentialId}`, {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accessToken: string; providerId: string };
      expect(body.accessToken).toBe("test-access-token");
      expect(body.providerId).toBe("test-oauth");
    });

    it("rejects api_key credentials (only OAuth rows are valid here)", async () => {
      const apiKeyRow = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        apiKey: "sk-test",
        providerId: "anthropic",
      });

      const res = await app.request(`/internal/oauth-token/${apiKeyRow.id}`, {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      // assertOAuthModelCredential passes (orgId matches); resolveOAuthTokenForSidecar
      // throws notFound because the provider isn't OAuth-enabled.
      expect(res.status).toBe(404);
    });

    // Remote-origin runs execute on the customer's host and never need
    // platform-stored OAuth tokens. The per-run pin is structurally NULL
    // for that origin, so we reject access at the route boundary to prevent
    // a leaked remote run-token from enumerating the org's OAuth credentials.
    it("returns 403 when the run is remote-origin (even for a same-org credential)", async () => {
      const credentialId = await seedOAuthCredential(ctx.orgId);
      const remote = await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
        runOrigin: "remote",
      });
      const remoteToken = signRunToken(remote.id);

      const res = await app.request(`/internal/oauth-token/${credentialId}`, {
        headers: { Authorization: `Bearer ${remoteToken}` },
      });
      expect(res.status).toBe(403);
    });

    it("returns 403 on POST /refresh when the run is remote-origin", async () => {
      const credentialId = await seedOAuthCredential(ctx.orgId);
      const remote = await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
        runOrigin: "remote",
      });
      const remoteToken = signRunToken(remote.id);

      const res = await app.request(`/internal/oauth-token/${credentialId}/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${remoteToken}` },
      });
      expect(res.status).toBe(403);
    });
  });
});
