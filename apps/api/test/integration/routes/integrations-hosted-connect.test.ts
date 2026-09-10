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
import { integrationConnections, integrationOauthClients, packages } from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  buildConnectUrl,
  connectClaimsFor,
} from "../../../src/services/connect/connect-session.ts";

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

/**
 * Classic (confidential) oauth2 auth — needs a pre-registered client per
 * space. Same shape as the `google` auth in `integrations.test.ts`.
 */
function oauthManifest(name = "@myorg/gsuite"): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    name,
    version: "0.1.0",
    display_name: "Google Workspace",
    description: "Google Workspace integration",
    icon: "logos:google",
    source: { kind: "local", server: { name, version: "^0.1.0" } },
    auths: {
      google: {
        type: "oauth2",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        default_scopes: ["openid", "email"],
        authorized_uris: ["https://www.googleapis.com/**"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
      },
    },
  } as unknown as IntegrationManifest;
}

/**
 * Remote MCP oauth2 auth with no pre-registered client (auto-DCR path). The
 * `.invalid` TLD (RFC 6761) makes discovery fail fast, so provisioning fails
 * without a live authorization server — same fixture as `integrations.test.ts`.
 */
function remoteMcpManifest(name = "@myorg/remote-mcp"): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    name,
    version: "1.0.0",
    display_name: "Remote MCP",
    description: "Remote MCP integration with MCP-spec auto-DCR",
    source: {
      kind: "remote",
      remote: { url: "https://mcp.invalid/mcp", transport: "streamable-http" },
    },
    auths: {
      oauth: {
        type: "oauth2",
        issuer: "https://mcp.invalid",
        token_endpoint_auth_method: "none",
        default_scopes: ["read", "write"],
        authorized_uris: ["https://mcp.invalid/**"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
        _meta: { "dev.appstrate/oauth": { scope_separator: " " } },
      },
    },
  } as unknown as IntegrationManifest;
}

async function startConnect(token: string): Promise<Response> {
  return app.request(`/api/integrations/connect/start?token=${encodeURIComponent(token)}`, {
    redirect: "manual",
  });
}

describe("hosted connect portal — oauth2 dispatch without a client (issues #1263, #1345)", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, oauthManifest("@myorg/gsuite"));
  });

  it("renders a permanent 403, not a generic 502 — and not the operator detail", async () => {
    const token = await mintSession(ctx, "@myorg/gsuite", "google");
    const res = await startConnect(token);
    // Status parity with `POST …/connect/oauth2` on the same space, and wording
    // that says "permanent": no "try again", which is what a 502 would invite.
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Ask an administrator");
    expect(html).not.toContain("Please try again");
    // The `detail` that names the remedy is written for an operator, and this
    // route has no session (issue #1345) — it belongs in the log line only.
    expect(html).not.toContain("Administrator must register OAuth client credentials");
  });

  it("keeps the link reusable: a second click is the same 403, not 'already used'", async () => {
    const token = await mintSession(ctx, "@myorg/gsuite", "google");
    expect((await startConnect(token)).status).toBe(403);
    const again = await startConnect(token);
    expect(again.status).toBe(403);
    expect(await again.text()).not.toContain("already been used");
  });

  it("lets the same link succeed once an administrator registers a client", async () => {
    const token = await mintSession(ctx, "@myorg/gsuite", "google");
    expect((await startConnect(token)).status).toBe(403);

    const registered = await app.request(
      "/api/integrations/@myorg/gsuite/auths/google/oauth-clients",
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "abc", client_secret: "shh" }),
      },
    );
    expect(registered.status).toBe(201);

    // The very same link now dispatches to the provider — no re-mint.
    const res = await startConnect(token);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("abc");

    // …and the successful click is the one that burns it.
    expect((await startConnect(token)).status).toBe(410);
  });

  it("keeps the auto-provisioning failure's own prose off a remote MCP popup", async () => {
    await seedIntegration(ctx.orgId, remoteMcpManifest("@myorg/remote-mcp"));
    const token = await mintSession(ctx, "@myorg/remote-mcp", "oauth");
    const res = await startConnect(token);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("Ask an administrator");
    // This `detail` embeds the authorization server's OWN message verbatim
    // (`resolveConnectClient` renders `provisioningFailure.message` as-is), so
    // it is upstream-controlled text on a session-less page. Log only.
    expect(html).not.toContain("Could not automatically provision an OAuth client");
    expect(html).not.toContain("dynamic client registration");
  });

  it("never names the row or the env var when a client_secret cannot be decrypted", async () => {
    // The ciphertext no longer opens (key rotated without re-encrypt, or
    // corruption): `has_client_secret` still reads true from the column while
    // the decrypt yields "", and `assertConnectClientUsable` refuses the
    // client with a 403 whose detail names the client row's uuid and
    // `CONNECTION_ENCRYPTION_KEY`. That is the disclosure of issue #1345.
    const registered = await app.request(
      "/api/integrations/@myorg/gsuite/auths/google/oauth-clients",
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "abc", client_secret: "shh" }),
      },
    );
    expect(registered.status).toBe(201);
    const clientId = ((await registered.json()) as { id: string }).id;
    await db
      .update(integrationOauthClients)
      .set({ clientSecretEncrypted: "not-a-valid-envelope" })
      .where(eq(integrationOauthClients.id, clientId));

    const res = await startConnect(await mintSession(ctx, "@myorg/gsuite", "google"));
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("Ask an administrator");
    for (const internal of ["CONNECTION_ENCRYPTION_KEY", "cannot be decrypted", clientId]) {
      expect(html).not.toContain(internal);
    }
  });
});

/**
 * The completion payload the popup broadcasts, as the browser would read it.
 *
 * The page inlines it as a single `var detail = {…};` statement of flat JSON
 * (`buildIntegrationConnectCompletion` produces no nested object), so the line
 * itself is the whole payload.
 */
function completionDetail(html: string): Record<string, unknown> {
  const match = /^\s*var detail = (\{.*\});$/m.exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

describe("hosted connect portal — error completions are addressed (issue #1346)", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, apiKeyManifest("@myorg/gmail"));
    await seedIntegration(ctx.orgId, oauthManifest("@myorg/gsuite"));
  });

  // A completion naming NOTHING is delivered to every waiting surface by
  // contract (`completionMatches`), and both carriers fan out — so a failing
  // Gmail link used to drive an open ClickUp card into an error naming Gmail.
  it("names the package on the OAuth-begin refusal", async () => {
    const res = await startConnect(await mintSession(ctx, "@myorg/gsuite", "google"));
    expect(res.status).toBe(403);
    expect(completionDetail(await res.text())).toMatchObject({
      ok: false,
      packageId: "@myorg/gsuite",
    });
  });

  it("names the package when the link has already been used", async () => {
    const token = await mintSession(ctx, "@myorg/gmail", "api");
    expect((await startConnect(token)).status).toBe(302);
    const again = await startConnect(token);
    expect(again.status).toBe(410);
    const detail = completionDetail(await again.text());
    expect(detail).toMatchObject({ ok: false, packageId: "@myorg/gmail" });
  });

  it("names the package when the integration is gone", async () => {
    const token = await mintSession(ctx, "@myorg/gmail", "api");
    await db.delete(packages).where(eq(packages.id, "@myorg/gmail"));
    const res = await startConnect(token);
    expect(res.status).toBe(410);
    expect(completionDetail(await res.text())).toMatchObject({
      ok: false,
      packageId: "@myorg/gmail",
    });
  });

  // The other half of the rule: the two pages that run BEFORE the claims are
  // decoded resolved no package and no state, so they stay context-less — that
  // is the case `completionMatches`'s permissive tail exists for, and widening
  // it is not what this fix does.
  it("leaves the pre-claims pages context-less", async () => {
    for (const query of ["", "?token=not-a-token"]) {
      const res = await app.request(`/api/integrations/connect/start${query}`, {
        redirect: "manual",
      });
      const detail = completionDetail(await res.text());
      expect(detail.packageId).toBeUndefined();
      expect(detail.state).toBeUndefined();
    }
  });
});

describe("hosted connect portal — a fault while resolving scopes (issue #1352)", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, oauthManifest("@myorg/gsuite"));
  });

  /**
   * Mint a capability token straight from claims. The mint route validates
   * `connection_id` against the caller's rows, and this case needs claims it
   * would refuse: a malformed id makes `getCurrentScopesGranted`'s row read
   * throw at the database the way a real fault there would. That read runs
   * after the jti is burned and before anything is sent upstream — the window
   * this test pins.
   */
  function mintUnreadableConnection(): string {
    const { connectUrl } = buildConnectUrl(
      connectClaimsFor({
        scope: { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId },
        actor: { type: "user", id: ctx.user.id },
        packageId: "@myorg/gsuite",
        authKey: "google",
        connectionId: "not-a-uuid",
      }),
    );
    return new URL(connectUrl).searchParams.get("token")!;
  }

  it("renders the popup error page, not raw problem+json", async () => {
    const res = await startConnect(mintUnreadableConnection());
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Please try again");
    // Addressed like every other completion this handler emits (issue #1346).
    expect(completionDetail(html)).toMatchObject({ ok: false, packageId: "@myorg/gsuite" });
  });

  it("hands the link back — this click spent nothing", async () => {
    const token = mintUnreadableConnection();
    expect((await startConnect(token)).status).toBe(500);
    const again = await startConnect(token);
    expect(again.status).toBe(500);
    expect(await again.text()).not.toContain("already been used");
  });
});
