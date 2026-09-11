// SPDX-License-Identifier: Apache-2.0

/**
 * Admin routes — `/api/spaces/:id/social-providers/:provider`.
 * Smoke tests for CRUD + secret redaction + provider scoping.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  memberContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { seedSpace } from "../../../../../../test/helpers/seed.ts";
import oidcModule from "../../../index.ts";
import { _clearSocialCacheForTesting } from "../../../services/social.ts";

const app = getTestApp({ modules: [oidcModule] });

describe("/api/spaces/:id/social-providers/:provider", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    _clearSocialCacheForTesting();
    ctx = await createTestContext({ orgSlug: "social-admin" });
  });

  it("PUT creates, GET returns without secret, DELETE removes", async () => {
    const url = `/api/spaces/${ctx.defaultSpaceId}/social-providers/google`;

    const putRes = await app.request(url, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "tenant.apps.googleusercontent.com",
        clientSecret: "super-secret",
        scopes: ["openid", "email", "profile"],
      }),
    });
    expect(putRes.status).toBe(200);
    const created = (await putRes.json()) as Record<string, unknown>;
    expect(created.provider).toBe("google");
    expect(created.clientId).toBe("tenant.apps.googleusercontent.com");
    expect(created).not.toHaveProperty("clientSecret");
    expect(created).not.toHaveProperty("clientSecretEncrypted");

    const getRes = await app.request(url, { headers: authHeaders(ctx) });
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as Record<string, unknown>;
    expect(got.clientId).toBe("tenant.apps.googleusercontent.com");
    expect(got).not.toHaveProperty("clientSecret");

    const delRes = await app.request(url, { method: "DELETE", headers: authHeaders(ctx) });
    expect(delRes.status).toBe(204);

    const notFoundRes = await app.request(url, { headers: authHeaders(ctx) });
    expect(notFoundRes.status).toBe(404);
  });

  it("rejects unknown provider with 404", async () => {
    const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/social-providers/facebook`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });

  it("404s for a space that does not belong to the caller's org", async () => {
    const res = await app.request(
      `/api/spaces/spc_${crypto.randomUUID()}/social-providers/google`,
      {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: "x", clientSecret: "y" }),
      },
    );
    expect(res.status).toBe(404);
  });

  // A malformed id is NOT "a space that is not yours": these routes now run the
  // canonical `validateSpaceInOrg`, whose shape guard answers 400 and names the
  // retired `app_` prefix when that is what arrived.
  it("400s for a malformed space id", async () => {
    const res = await app.request(`/api/spaces/spc_doesnotexist/social-providers/google`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Malformed space id");
  });

  it("scopes rows by (app, provider) — google and github are independent", async () => {
    await app.request(`/api/spaces/${ctx.defaultSpaceId}/social-providers/google`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "g", clientSecret: "gs" }),
    });
    const ghRes = await app.request(`/api/spaces/${ctx.defaultSpaceId}/social-providers/github`, {
      headers: authHeaders(ctx),
    });
    expect(ghRes.status).toBe(404);

    await app.request(`/api/spaces/${ctx.defaultSpaceId}/social-providers/github`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "gh", clientSecret: "ghs" }),
    });
    const ghGetRes = await app.request(
      `/api/spaces/${ctx.defaultSpaceId}/social-providers/github`,
      { headers: authHeaders(ctx) },
    );
    expect(ghGetRes.status).toBe(200);
    const gh = (await ghGetRes.json()) as Record<string, unknown>;
    expect(gh.clientId).toBe("gh");
  });
});

/**
 * #1337 — same gate as the SMTP family: the social-provider routes moved off
 * the org-level `spaces:read` / `spaces:write` onto the space-level
 * `space-settings:write`, resolved in the space named by `:id`.
 */
describe("/api/spaces/:id/social-providers/:provider — space membership gate", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    _clearSocialCacheForTesting();
    ctx = await createTestContext({ orgSlug: "social-gate" });
  });

  it("404s a guest on a private space it is not in", async () => {
    const space = await seedSpace({
      orgId: ctx.orgId,
      name: "Private",
      visibility: "private",
      createdBy: ctx.user.id,
    });
    const seeded = await app.request(`/api/spaces/${space.id}/social-providers/google`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "tenant.apps.googleusercontent.com",
        clientSecret: "super-secret",
      }),
    });
    expect(seeded.status).toBe(200);

    const guest = await memberContext(ctx, "guest");
    const res = await app.request(`/api/spaces/${space.id}/social-providers/google`, {
      headers: authHeaders(guest),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("tenant.apps.googleusercontent.com");
  });

  it("403s a member of the space that does not administer it", async () => {
    const viewer = await memberContext(ctx, "member", "viewer");
    const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/social-providers/google`, {
      headers: authHeaders(viewer),
    });
    expect(res.status).toBe(403);
  });
});
