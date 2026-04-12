// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `/api/oauth/clients*` admin routes — polymorphic.
 *
 * Covers CRUD + rotate + cross-org isolation + 404 handling for both
 * `dashboard` and `end_user` client types.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import oidcModule from "../../../index.ts";
import { oauthClient, oauthAccessToken, oauthRefreshToken, oauthConsent } from "../../../schema.ts";

const app = getTestApp({ modules: [oidcModule] });

function applicationLevelBody(ctx: TestContext, overrides: Record<string, unknown> = {}) {
  return {
    level: "application" as const,
    name: "Acme Portal",
    redirectUris: ["https://acme.example.com/oauth/callback"],
    referencedApplicationId: ctx.defaultAppId,
    ...overrides,
  };
}

function orgLevelBody(ctx: TestContext, overrides: Record<string, unknown> = {}) {
  return {
    level: "org" as const,
    name: "Acme Admin",
    redirectUris: ["https://acme.example.com/oauth/callback"],
    referencedOrgId: ctx.orgId,
    ...overrides,
  };
}

describe("OAuth clients admin routes (polymorphic)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "oauthroutes" });
  });

  it("POST creates an end_user client and returns the plaintext secret once", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(applicationLevelBody(ctx)),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      clientId: string;
      clientSecret: string;
      level: string;
      referencedApplicationId: string | null;
      referencedOrgId: string | null;
      redirectUris: string[];
    };
    expect(body.clientId).toStartWith("oauth_");
    expect(body.clientSecret.length).toBeGreaterThan(20);
    expect(body.level).toBe("application");
    expect(body.referencedApplicationId).toBe(ctx.defaultAppId);
    expect(body.referencedOrgId).toBeNull();
    expect(body.redirectUris).toEqual(["https://acme.example.com/oauth/callback"]);

    const [row] = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, body.clientId));
    expect(row).toBeDefined();
    expect(row!.clientSecret).not.toBe(body.clientSecret);
    expect(row!.clientSecret?.length).toBe(64);
  });

  it("POST creates a dashboard client pinned to the current org", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(orgLevelBody(ctx)),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      level: string;
      referencedOrgId: string | null;
      referencedApplicationId: string | null;
    };
    expect(body.level).toBe("org");
    expect(body.referencedOrgId).toBe(ctx.orgId);
    expect(body.referencedApplicationId).toBeNull();
  });

  it("POST rejects dashboard client for a different org (403)", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(orgLevelBody(ctx, { referencedOrgId: crypto.randomUUID() })),
    });
    expect(res.status).toBe(403);
  });

  it("POST rejects end_user client for an app the org does not own (403)", async () => {
    const other = await createTestContext({ orgSlug: "otherorg" });
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(
        applicationLevelBody(ctx, { referencedApplicationId: other.defaultAppId }),
      ),
    });
    expect(res.status).toBe(403);
  });

  it("POST rejects invalid redirect URIs", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(applicationLevelBody(ctx, { redirectUris: ["not-a-url"] })),
    });
    expect(res.status).toBe(400);
  });

  const blockedRedirectUris: Array<[string, string]> = [
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,<script>alert(1)</script>"],
    ["file scheme", "file:///etc/passwd"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["RFC1918 10/8", "http://10.0.0.1/callback"],
    ["RFC1918 192.168/16", "http://192.168.1.1/callback"],
    ["public http host", "http://satellite.example.com/callback"],
  ];
  for (const [label, uri] of blockedRedirectUris) {
    it(`POST rejects blocked redirect URI (${label})`, async () => {
      const res = await app.request("/api/oauth/clients", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(applicationLevelBody(ctx, { redirectUris: [uri] })),
      });
      expect(res.status).toBe(400);
    });
  }

  it("POST accepts https redirect URI on a public host", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(
        applicationLevelBody(ctx, {
          redirectUris: ["https://satellite.example.com/oauth/callback"],
        }),
      ),
    });
    expect(res.status).toBe(201);
  });

  it("POST accepts http://localhost redirect URI in dev mode", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(
        applicationLevelBody(ctx, { redirectUris: ["http://localhost:5173/auth/callback"] }),
      ),
    });
    expect(res.status).toBe(201);
  });

  it("POST rejects scopes outside the APPSTRATE_SCOPES whitelist", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(
        applicationLevelBody(ctx, { scopes: ["openid", "profile", "email", "superadmin:*"] }),
      ),
    });
    expect(res.status).toBe(400);
  });

  it("POST accepts the full APPSTRATE_SCOPES vocabulary", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(
        applicationLevelBody(ctx, {
          scopes: ["openid", "profile", "email", "offline_access", "runs:read"],
        }),
      ),
    });
    expect(res.status).toBe(201);
  });

  it("POST rejects missing name", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(applicationLevelBody(ctx, { name: undefined })),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/oauth/clients lists every client visible to the org", async () => {
    await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(applicationLevelBody(ctx, { name: "EndUser One" })),
    });
    await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(orgLevelBody(ctx, { name: "Dashboard One" })),
    });

    const res = await app.request("/api/oauth/clients", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { name: string | null; level: string }[];
    };
    expect(body.data.length).toBe(2);
    const names = body.data.map((c) => c.name).sort();
    expect(names).toEqual(["Dashboard One", "EndUser One"]);
  });

  it("GET /api/oauth/clients/:id returns a single client without the secret", async () => {
    const createRes = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(applicationLevelBody(ctx)),
    });
    const created = (await createRes.json()) as { clientId: string };

    const res = await app.request(`/api/oauth/clients/${created.clientId}`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.clientId).toBe(created.clientId);
    expect(body.clientSecret).toBeUndefined();
  });

  it("GET /api/oauth/clients/:id returns 404 for unknown id", async () => {
    const res = await app.request("/api/oauth/clients/oauth_nope", { headers: authHeaders(ctx) });
    expect(res.status).toBe(404);
  });

  it("PATCH updates redirectUris, disabled, and isFirstParty", async () => {
    const createRes = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(applicationLevelBody(ctx)),
    });
    const { clientId } = (await createRes.json()) as { clientId: string };

    const res = await app.request(`/api/oauth/clients/${clientId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        redirectUris: ["https://new.example.com/cb", "https://other.example.com/cb"],
        disabled: true,
        isFirstParty: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      redirectUris: string[];
      disabled: boolean;
      isFirstParty: boolean;
    };
    expect(body.redirectUris).toEqual([
      "https://new.example.com/cb",
      "https://other.example.com/cb",
    ]);
    expect(body.disabled).toBe(true);
    expect(body.isFirstParty).toBe(true);
  });

  it("POST /rotate returns a new plaintext secret and updates the hash", async () => {
    const createRes = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(applicationLevelBody(ctx)),
    });
    const first = (await createRes.json()) as { clientId: string; clientSecret: string };

    const [beforeRow] = await db
      .select({ secret: oauthClient.clientSecret })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, first.clientId));

    const res = await app.request(`/api/oauth/clients/${first.clientId}/rotate`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as { clientSecret: string; clientId: string };
    expect(rotated.clientId).toBe(first.clientId);
    expect(rotated.clientSecret).not.toBe(first.clientSecret);

    const [afterRow] = await db
      .select({ secret: oauthClient.clientSecret })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, first.clientId));
    expect(afterRow!.secret).not.toBe(beforeRow!.secret);
    expect(afterRow!.secret).not.toBe(rotated.clientSecret);
  });

  it("DELETE removes the client and returns 204", async () => {
    const createRes = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(applicationLevelBody(ctx)),
    });
    const { clientId } = (await createRes.json()) as { clientId: string };

    const del = await app.request(`/api/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(204);

    const rows = await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId));
    expect(rows.length).toBe(0);

    const get404 = await app.request(`/api/oauth/clients/${clientId}`, {
      headers: authHeaders(ctx),
    });
    expect(get404.status).toBe(404);
  });

  it("DELETE cascades child tokens + consent rows", async () => {
    const createRes = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(
        applicationLevelBody(ctx, {
          name: "Used client",
          redirectUris: ["https://c.example.com/cb"],
        }),
      ),
    });
    const { clientId } = (await createRes.json()) as { clientId: string };

    const now = new Date();
    await db.insert(oauthRefreshToken).values({
      id: "rt_test_1",
      token: "rt_token_1",
      clientId,
      userId: ctx.user.id,
      scopes: ["openid"],
      createdAt: now,
    });
    await db.insert(oauthAccessToken).values({
      id: "at_test_1",
      token: "at_token_1",
      clientId,
      userId: ctx.user.id,
      refreshId: "rt_test_1",
      scopes: ["openid"],
      createdAt: now,
    });
    await db.insert(oauthConsent).values({
      id: "cs_test_1",
      clientId,
      userId: ctx.user.id,
      scopes: ["openid"],
      createdAt: now,
      updatedAt: now,
    });

    const del = await app.request(`/api/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(204);

    expect(
      (await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId))).length,
    ).toBe(0);
    expect(
      (await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.clientId, clientId)))
        .length,
    ).toBe(0);
    expect(
      (await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.clientId, clientId)))
        .length,
    ).toBe(0);
    expect(
      (await db.select().from(oauthConsent).where(eq(oauthConsent.clientId, clientId))).length,
    ).toBe(0);
  });

  it("isolates clients per org", async () => {
    const otherCtx = await createTestContext({ orgSlug: "otherapp" });
    await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(applicationLevelBody(ctx, { name: "Org A client" })),
    });
    await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(otherCtx), "Content-Type": "application/json" },
      body: JSON.stringify(applicationLevelBody(otherCtx, { name: "Org B client" })),
    });

    const listA = await app.request("/api/oauth/clients", { headers: authHeaders(ctx) });
    const listB = await app.request("/api/oauth/clients", { headers: authHeaders(otherCtx) });
    const bodyA = (await listA.json()) as { data: { name: string | null }[] };
    const bodyB = (await listB.json()) as { data: { name: string | null }[] };
    expect(bodyA.data.map((c) => c.name)).toEqual(["Org A client"]);
    expect(bodyB.data.map((c) => c.name)).toEqual(["Org B client"]);
  });

  // ── Logout route ──────────────────────────────────────────────────────────

  it("GET /api/oauth/logout redirects to / when no client_id or redirect_uri", async () => {
    const res = await app.request("/api/oauth/logout", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("better-auth.session_token=;");
  });

  it("GET /api/oauth/logout validates against postLogoutRedirectUris", async () => {
    const createRes = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(
        applicationLevelBody(ctx, {
          postLogoutRedirectUris: ["https://portal.example.com/"],
        }),
      ),
    });
    const { clientId } = (await createRes.json()) as { clientId: string };

    // Registered post-logout URI should redirect
    const goodRes = await app.request(
      `/api/oauth/logout?client_id=${clientId}&post_logout_redirect_uri=${encodeURIComponent("https://portal.example.com/")}`,
      { redirect: "manual" },
    );
    expect(goodRes.status).toBe(302);
    expect(goodRes.headers.get("location")).toBe("https://portal.example.com/");

    // Unregistered URI should fall back to /
    const badRes = await app.request(
      `/api/oauth/logout?client_id=${clientId}&post_logout_redirect_uri=${encodeURIComponent("https://evil.example.com/phish")}`,
      { redirect: "manual" },
    );
    expect(badRes.status).toBe(302);
    expect(badRes.headers.get("location")).toBe("/");
  });

  it("GET /api/oauth/logout falls back to redirectUris when postLogoutRedirectUris is empty", async () => {
    const createRes = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(applicationLevelBody(ctx)),
    });
    const { clientId } = (await createRes.json()) as { clientId: string };

    // The redirectUri (https://acme.example.com/oauth/callback) should be accepted
    // as a fallback even though postLogoutRedirectUris is empty.
    const res = await app.request(
      `/api/oauth/logout?client_id=${clientId}&post_logout_redirect_uri=${encodeURIComponent("https://acme.example.com/oauth/callback")}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://acme.example.com/oauth/callback");
  });

  it("GET /api/oauth/logout falls back to / when post_logout_redirect_uri sent without client_id", async () => {
    const res = await app.request(
      `/api/oauth/logout?post_logout_redirect_uri=${encodeURIComponent("https://portal.example.com/")}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  // ── PATCH atomicity + isFirstParty auth ───────────────────────────────────

  it("PATCH updates a single field without affecting others", async () => {
    const createRes = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(applicationLevelBody(ctx)),
    });
    const { clientId, redirectUris } = (await createRes.json()) as {
      clientId: string;
      redirectUris: string[];
    };

    // Only update disabled, leaving redirectUris and isFirstParty untouched
    const patchRes = await app.request(`/api/oauth/clients/${clientId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    expect(patchRes.status).toBe(200);
    const body = (await patchRes.json()) as {
      disabled: boolean;
      isFirstParty: boolean;
      redirectUris: string[];
    };
    expect(body.disabled).toBe(true);
    expect(body.isFirstParty).toBe(false);
    expect(body.redirectUris).toEqual(redirectUris);
  });
});
