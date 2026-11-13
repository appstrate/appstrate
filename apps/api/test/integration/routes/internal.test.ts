// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedAgent,
  seedRun,
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
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      status: "running",
    });
    runningRunId = exec.id;
    runningToken = signRunToken(runningRunId);
  });

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
        spaceId: ctx.defaultSpaceId,
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
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.access_token).toBe("test-access-token");
      expect(body).not.toHaveProperty("accessToken");
      // No identity surfaced → the key is omitted, never `null`.
      expect(body).not.toHaveProperty("account_id");
    });

    it("emits the stored account id as snake_case `account_id`", async () => {
      const row = await seedOrgModelProviderOAuth({ orgId: ctx.orgId, accountId: "acct-42" });
      const token = await seedPinnedRun(row.id);

      const res = await app.request(`/internal/oauth-token/${row.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.account_id).toBe("acct-42");
      expect(body).not.toHaveProperty("accountId");
      expect(typeof body.expiresAt).toBe("number");
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
        spaceId: ctx.defaultSpaceId,
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
        spaceId: ctx.defaultSpaceId,
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
