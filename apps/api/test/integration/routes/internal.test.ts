// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedAgent,
  seedRun,
  seedEndUser,
  seedOrgModelProviderKey,
  seedOrgModelProviderOAuth,
} from "../../helpers/seed.ts";
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
  // ─── GET /internal/oauth-token/:credentialId ───────────
  //
  // The path param is a `model_provider_credentials.id`, and it MUST equal the
  // run's own `modelCredentialId` pin. These tests pin two contracts: the old
  // bug (validation against `userProviderConnections.id`, always 404) cannot
  // reappear, and a run with no pin can never vend a sibling credential.

  describe("GET /internal/oauth-token/:credentialId", () => {
    async function seedOAuthCredential(orgId: string): Promise<string> {
      const row = await seedOrgModelProviderOAuth({ orgId });
      return row.id;
    }

    /** A running run pinned to `credentialId`, plus its signed bearer. */
    async function seedPinnedRun(credentialId: string): Promise<string> {
      const run = await seedRun({
        packageId: pkgId,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
        modelCredentialId: credentialId,
      });
      return signRunToken(run.id);
    }

    it("returns 401 without a run token", async () => {
      const res = await app.request("/internal/oauth-token/some-id");
      expect(res.status).toBe(401);
    });

    // CRIT-06 regression. `runningToken` belongs to a run with NO pinned
    // credential (the platform-origin API-key-model shape). Before the fix the
    // equality gate was skipped for a null pin, so a leaked run bearer could
    // read or refresh ANY OAuth credential in the org.
    it("returns 403 when the run has no pinned credential, even for a same-org credential", async () => {
      const credentialId = await seedOAuthCredential(ctx.orgId);

      const res = await app.request(`/internal/oauth-token/${credentialId}`, {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(403);
    });

    it("returns 403 on POST /refresh when the run has no pinned credential", async () => {
      const credentialId = await seedOAuthCredential(ctx.orgId);

      const res = await app.request(`/internal/oauth-token/${credentialId}/refresh`, {
        method: "POST",
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(403);
    });

    it("returns 403 when the requested credential is not the run's pin", async () => {
      const pinned = await seedOAuthCredential(ctx.orgId);
      const sibling = await seedOAuthCredential(ctx.orgId);
      const token = await seedPinnedRun(pinned);

      const res = await app.request(`/internal/oauth-token/${sibling}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    it("returns 403 (not 500) when the credentialId is not a valid UUID", async () => {
      // The equality gate rejects before the row lookup, so a malformed param
      // can no longer reach the driver and surface a 22P02 as a 500.
      const pinned = await seedOAuthCredential(ctx.orgId);
      const token = await seedPinnedRun(pinned);

      const res = await app.request("/internal/oauth-token/not-a-uuid", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    it("returns 403 when the pinned credential belongs to another org", async () => {
      const otherOrg = await createTestContext({ orgSlug: "otherorg" });
      const credentialId = await seedOAuthCredential(otherOrg.orgId);
      // Pin the run to the foreign credential so the equality gate passes and
      // the org-membership check is the assertion actually under test.
      const token = await seedPinnedRun(credentialId);

      const res = await app.request(`/internal/oauth-token/${credentialId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(403);
    });

    it("returns 200 with a resolved token when the credential matches the run pin and org", async () => {
      const credentialId = await seedOAuthCredential(ctx.orgId);
      const token = await seedPinnedRun(credentialId);

      const res = await app.request(`/internal/oauth-token/${credentialId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      // The response wire shape (OAuthTokenResponse) deliberately omits
      // provider invariants (providerId, baseUrl) — those live
      // in the LlmProxyOauthConfig delivered to the sidecar via env at
      // boot and never change per refresh. See packages/core/src/sidecar-types.ts.
      const body = (await res.json()) as { accessToken: string };
      expect(body.accessToken).toBe("test-access-token");
    });

    it("rejects api_key credentials (only OAuth rows are valid here)", async () => {
      const apiKeyRow = await seedOrgModelProviderKey({
        orgId: ctx.orgId,
        apiKey: "sk-test",
        providerId: "anthropic",
      });
      const token = await seedPinnedRun(apiKeyRow.id);

      const res = await app.request(`/internal/oauth-token/${apiKeyRow.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // assertOAuthModelCredential passes (pin + orgId match);
      // resolveOAuthTokenForSidecar throws notFound because the provider
      // isn't OAuth-enabled.
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
