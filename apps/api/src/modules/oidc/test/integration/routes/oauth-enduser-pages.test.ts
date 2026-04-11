// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the OIDC module's public login + consent pages.
 *
 * Scope: GET rendering + XSS safety + client_id validation. The POST
 * handlers currently return 501 (plugin wiring deferred to Stage 5.5);
 * that contract is also asserted here so any future plugin landing
 * forces the test to be updated deliberately.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

async function registerClient(
  ctx: TestContext,
  body: { name: string; redirectUris: string[] } = {
    name: "Acme Portal",
    redirectUris: ["https://acme.example.com/oauth/callback"],
  },
): Promise<{ clientId: string; clientSecret: string }> {
  const res = await app.request("/api/oauth/clients", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { clientId: string; clientSecret: string };
}

describe("Public end-user pages — /api/oauth/enduser/*", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "oidcpages" });
  });

  it("GET /login renders a form with the escaped query string and no auth required", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}&state=xyz&scope=openid%20runs`;
    const res = await app.request(`/api/oauth/enduser/login${qs}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('method="POST"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    // Form action echoes the query string back with `&` HTML-escaped to `&amp;`.
    const escapedQs = qs.replace(/&/g, "&amp;");
    expect(html).toContain(`action="/api/oauth/enduser/login${escapedQs}"`);
  });

  it("GET /login always HTML-escapes `&` in the forwarded query string", async () => {
    // Bun's URL parser percent-encodes literal `<`, `"`, etc. before they reach
    // the route, so those never arrive raw. The vector that DOES arrive intact
    // is `&` — the query-string separator — and it must be escaped to `&amp;`
    // in the form action to satisfy HTML5 attribute parsing. Direct unit tests
    // on `escapeHtml` + `renderLoginPage` cover the raw-character vectors.
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}&state=x&scope=openid`;
    const res = await app.request(`/api/oauth/enduser/login${qs}`);
    expect(res.status).toBe(200);
    const htmlOut = await res.text();
    expect(htmlOut).not.toContain(`action="/api/oauth/enduser/login${qs}"`);
    expect(htmlOut).toContain(`state=x&amp;scope=openid`);
  });

  it("GET /login 404s on unknown client_id", async () => {
    const res = await app.request(
      "/api/oauth/enduser/login?client_id=oauth_totally_unknown&state=x",
    );
    expect(res.status).toBe(404);
  });

  it("GET /login 400s when client_id is missing", async () => {
    const res = await app.request("/api/oauth/enduser/login?state=x");
    expect(res.status).toBe(400);
  });

  it("GET /login 404s on a disabled client", async () => {
    const { clientId } = await registerClient(ctx);
    await app.request(`/api/oauth/clients/${clientId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    const res = await app.request(
      `/api/oauth/enduser/login?client_id=${encodeURIComponent(clientId)}`,
    );
    expect(res.status).toBe(404);
  });

  it("GET /consent renders the client name and the requested scopes", async () => {
    const { clientId } = await registerClient(ctx, {
      name: "Team Portal",
      redirectUris: ["https://team.example.com/cb"],
    });
    const qs = `?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(
      "openid runs agents:write",
    )}&state=s1`;
    const res = await app.request(`/api/oauth/enduser/consent${qs}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Team Portal");
    expect(html).toContain("Votre historique d&#39;exécutions (lecture)");
    expect(html).toContain("Vos agents (lecture et exécution)");
    // Two forms (deny + allow) both posting back to the same action.
    const escapedQs = qs.replace(/&/g, "&amp;");
    expect(html).toContain(`action="/api/oauth/enduser/consent${escapedQs}"`);
  });

  it("GET /consent escapes XSS in the client name", async () => {
    const { clientId } = await registerClient(ctx, {
      name: `<img src=x onerror=alert(1)>`,
      redirectUris: ["https://x.example.com/cb"],
    });
    const res = await app.request(
      `/api/oauth/enduser/consent?client_id=${encodeURIComponent(clientId)}&scope=openid`,
    );
    const html = await res.text();
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("GET /consent 404s on unknown client_id", async () => {
    const res = await app.request("/api/oauth/enduser/consent?client_id=oauth_nope&scope=openid");
    expect(res.status).toBe(404);
  });

  it("POST /login returns 501 (Stage 5.5 plugin wiring pending)", async () => {
    const { clientId } = await registerClient(ctx);
    const res = await app.request(
      `/api/oauth/enduser/login?client_id=${encodeURIComponent(clientId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "email=a@b.com&password=hunter2",
      },
    );
    expect(res.status).toBe(501);
  });

  it("POST /consent returns 501 (Stage 5.5 plugin wiring pending)", async () => {
    const { clientId } = await registerClient(ctx);
    const res = await app.request(
      `/api/oauth/enduser/consent?client_id=${encodeURIComponent(clientId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "accept=true",
      },
    );
    expect(res.status).toBe(501);
  });
});
