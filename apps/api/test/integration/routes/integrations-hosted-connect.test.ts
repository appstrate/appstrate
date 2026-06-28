// SPDX-License-Identifier: Apache-2.0
/**
 * Integration tests for the hosted connect portal (issue #769).
 *
 * Covers the unified, auth-type-agnostic connect surface:
 *  - mint a connect session (`POST .../connect/session`) → `connect_url`
 *  - dispatch (`GET /connect/start`) — page cookie + single-use jti + redirect
 *  - render context (`GET /connect/context`) — page cookie, no secret
 *  - submit (`POST /connect/submit`) — page cookie + CSRF, persists credentials
 *  - reconnect in place via `connection_id`
 *
 * OAuth dispatch internals are covered by the existing `/connect/oauth2` tests;
 * here we assert only that mint works for an oauth2 auth.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";

const app = getTestApp();

function apiKeyManifest(name = "@myorg/gmail"): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    name,
    version: "0.1.0",
    display_name: "Gmail",
    description: "Gmail integration",
    icon: "logos:google-gmail",
    source: { kind: "local", server: { name, version: "^0.1.0" } },
    auths: {
      api: {
        type: "api_key",
        authorized_uris: ["https://gmail.googleapis.com/**"],
        credentials: { schema: { type: "object", properties: { api_key: { type: "string" } } } },
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.api_key}",
          },
        },
      },
    },
  } as unknown as IntegrationManifest;
}

async function seedIntegration(orgId: string, manifest: IntegrationManifest) {
  return seedPackage({
    id: manifest.name,
    orgId,
    type: "integration",
    source: "local",
    draftManifest: manifest,
  });
}

/** Extract the `appstrate_connect` cookie value from a Set-Cookie header. */
function readSetCookie(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const m = raw.match(/appstrate_connect=([^;]+)/);
  return m ? m[1]! : null;
}

async function mintSession(
  ctx: TestContext,
  packageId: string,
  authKey: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.request(`/api/integrations/${packageId}/auths/${authKey}/connect/session`, {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { connect_url: string; expires_at: number };
  expect(typeof json.expires_at).toBe("number");
  const url = new URL(json.connect_url);
  const token = url.searchParams.get("token");
  expect(token).toBeTruthy();
  return token!;
}

describe("hosted connect portal — mint", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, apiKeyManifest("@myorg/gmail"));
  });

  it("mints a connect_url for an api_key auth", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/session", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { connect_url: string; expires_at: number };
    expect(json.connect_url).toContain("/api/integrations/connect/start?token=");
  });

  it("404s when the auth key does not exist", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/nope/connect/session", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("hosted connect portal — dispatch + submit", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, apiKeyManifest("@myorg/gmail"));
  });

  it("dispatches a non-oauth token to the hosted form and sets a page cookie", async () => {
    const token = await mintSession(ctx, "@myorg/gmail", "api");
    const start = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toBe("/connect");
    expect(readSetCookie(start)).toBeTruthy();
  });

  it("rejects a reused token (single-use jti)", async () => {
    const token = await mintSession(ctx, "@myorg/gmail", "api");
    const first = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(first.status).toBe(302);
    const second = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(second.status).toBe(410);
  });

  it("rejects an invalid token", async () => {
    const res = await app.request("/api/integrations/connect/start?token=garbage", {
      redirect: "manual",
    });
    expect(res.status).toBe(410);
  });

  it("400s when the token is missing", async () => {
    const res = await app.request("/api/integrations/connect/start", { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  it("serves render context (no secret) and accepts a submit with CSRF", async () => {
    const token = await mintSession(ctx, "@myorg/gmail", "api");
    const start = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    const cookie = `appstrate_connect=${readSetCookie(start)}`;

    const ctxRes = await app.request("/api/integrations/connect/context", {
      headers: { Cookie: cookie },
    });
    expect(ctxRes.status).toBe(200);
    const context = (await ctxRes.json()) as {
      package_id: string;
      auth_key: string;
      display_name: string;
      auth: { type: string };
      csrf: string;
    };
    expect(context.package_id).toBe("@myorg/gmail");
    expect(context.auth_key).toBe("api");
    expect(context.display_name).toBe("Gmail");
    expect(context.auth.type).toBe("api_key");
    expect(context.csrf).toBeTruthy();

    const submit = await app.request("/api/integrations/connect/submit", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "x-connect-csrf": context.csrf,
      },
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET" } }),
    });
    expect(submit.status).toBe(200);
    const result = (await submit.json()) as { ok: boolean; connection: { id: string } };
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, result.connection.id));
    expect(rows).toHaveLength(1);
  });

  it("rejects a submit without the CSRF header", async () => {
    const token = await mintSession(ctx, "@myorg/gmail", "api");
    const start = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    const cookie = `appstrate_connect=${readSetCookie(start)}`;
    const submit = await app.request("/api/integrations/connect/submit", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET" } }),
    });
    expect(submit.status).toBe(400);
  });

  it("404s context/submit without a page cookie", async () => {
    const ctxRes = await app.request("/api/integrations/connect/context");
    expect(ctxRes.status).toBe(404);
  });

  it("reconnects in place when connection_id is supplied — no duplicate", async () => {
    // First connect.
    const token1 = await mintSession(ctx, "@myorg/gmail", "api");
    const start1 = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token1)}`,
      { redirect: "manual" },
    );
    const cookie1 = `appstrate_connect=${readSetCookie(start1)}`;
    const c1 = (await (
      await app.request("/api/integrations/connect/context", { headers: { Cookie: cookie1 } })
    ).json()) as { csrf: string };
    const created = (await (
      await app.request("/api/integrations/connect/submit", {
        method: "POST",
        headers: { Cookie: cookie1, "Content-Type": "application/json", "x-connect-csrf": c1.csrf },
        body: JSON.stringify({ credentials: { api_key: "AKIA-FIRST" } }),
      })
    ).json()) as { connection: { id: string } };

    // Reconnect: mint with connection_id.
    const token2 = await mintSession(ctx, "@myorg/gmail", "api", {
      connection_id: created.connection.id,
    });
    const start2 = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token2)}`,
      { redirect: "manual" },
    );
    const cookie2 = `appstrate_connect=${readSetCookie(start2)}`;
    const c2 = (await (
      await app.request("/api/integrations/connect/context", { headers: { Cookie: cookie2 } })
    ).json()) as { csrf: string; connection_id: string };
    expect(c2.connection_id).toBe(created.connection.id);
    const renewed = (await (
      await app.request("/api/integrations/connect/submit", {
        method: "POST",
        headers: { Cookie: cookie2, "Content-Type": "application/json", "x-connect-csrf": c2.csrf },
        body: JSON.stringify({ credentials: { api_key: "AKIA-RENEWED" } }),
      })
    ).json()) as { connection: { id: string } };
    expect(renewed.connection.id).toBe(created.connection.id);

    const all = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, "@myorg/gmail"));
    expect(all).toHaveLength(1);
  });
});
