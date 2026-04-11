// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `/api/oauth/clients*` admin routes.
 *
 * Covers CRUD + rotate + cross-app isolation + 404 handling. Uses the real
 * OIDC module loaded via `getTestApp({ modules })` so the router + OpenAPI +
 * appScopedPaths wiring is all exercised end-to-end.
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
import { oauthClient } from "../../../schema.ts";

const app = getTestApp({ modules: [oidcModule] });

describe("OAuth clients admin routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "oauthroutes" });
  });

  it("POST /api/oauth/clients creates a client and returns the plaintext secret once", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Acme Portal",
        redirectUris: ["https://acme.example.com/oauth/callback"],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      clientId: string;
      clientSecret: string;
      applicationId: string;
      redirectUris: string[];
    };
    expect(body.clientId).toStartWith("oauth_");
    expect(body.clientSecret.length).toBeGreaterThan(20);
    expect(body.applicationId).toBe(ctx.defaultAppId);
    expect(body.redirectUris).toEqual(["https://acme.example.com/oauth/callback"]);

    // DB row carries a hashed secret (not the plaintext).
    const [row] = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, body.clientId));
    expect(row).toBeDefined();
    expect(row!.clientSecret).not.toBe(body.clientSecret);
    expect(row!.clientSecret?.length).toBe(64); // hex SHA-256
  });

  it("POST rejects invalid redirect URIs", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad",
        redirectUris: ["not-a-url"],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST rejects missing name", async () => {
    const res = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        redirectUris: ["https://acme.example.com/oauth/callback"],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/oauth/clients lists clients scoped to the current app", async () => {
    await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "One", redirectUris: ["https://a.example.com/cb"] }),
    });
    await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Two", redirectUris: ["https://b.example.com/cb"] }),
    });

    const res = await app.request("/api/oauth/clients", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: { clientId: string; name: string | null }[];
    };
    expect(body.object).toBe("list");
    expect(body.data.length).toBe(2);
    const names = body.data.map((c) => c.name).sort();
    expect(names).toEqual(["One", "Two"]);
  });

  it("GET /api/oauth/clients/:id returns a single client without the secret", async () => {
    const createRes = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "One", redirectUris: ["https://a.example.com/cb"] }),
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

  it("PATCH updates redirectUris and disabled flag", async () => {
    const createRes = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "One", redirectUris: ["https://a.example.com/cb"] }),
    });
    const { clientId } = (await createRes.json()) as { clientId: string };

    const res = await app.request(`/api/oauth/clients/${clientId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        redirectUris: ["https://new.example.com/cb", "https://other.example.com/cb"],
        disabled: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      redirectUris: string[];
      disabled: boolean;
    };
    expect(body.redirectUris).toEqual([
      "https://new.example.com/cb",
      "https://other.example.com/cb",
    ]);
    expect(body.disabled).toBe(true);
  });

  it("POST /rotate returns a new plaintext secret and updates the hash", async () => {
    const createRes = await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "One", redirectUris: ["https://a.example.com/cb"] }),
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
      body: JSON.stringify({ name: "One", redirectUris: ["https://a.example.com/cb"] }),
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

  it("isolates clients per application", async () => {
    const otherCtx = await createTestContext({ orgSlug: "otherapp" });
    // Both contexts independently create clients.
    await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "App A client", redirectUris: ["https://a.example.com/cb"] }),
    });
    await app.request("/api/oauth/clients", {
      method: "POST",
      headers: { ...authHeaders(otherCtx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "App B client", redirectUris: ["https://b.example.com/cb"] }),
    });

    const listA = await app.request("/api/oauth/clients", { headers: authHeaders(ctx) });
    const listB = await app.request("/api/oauth/clients", { headers: authHeaders(otherCtx) });
    const bodyA = (await listA.json()) as { data: { name: string | null }[] };
    const bodyB = (await listB.json()) as { data: { name: string | null }[] };
    expect(bodyA.data.map((c) => c.name)).toEqual(["App A client"]);
    expect(bodyB.data.map((c) => c.name)).toEqual(["App B client"]);
  });

  it("requires X-App-Id (appScopedPaths enforcement)", async () => {
    const res = await app.request("/api/oauth/clients", {
      headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
    });
    // Missing X-App-Id → core app-context middleware rejects before the route.
    expect([400, 403]).toContain(res.status);
  });
});
