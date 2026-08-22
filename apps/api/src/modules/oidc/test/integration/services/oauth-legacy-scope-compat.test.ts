// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #1177 — a third-party OAuth client that still asks for `documents:read`.
 *
 * The permission resource `documents` was renamed to `files`, and migration
 * 0044 rewrote the stored `oauth_clients.scopes` strings. But a scope string is
 * not only stored — it is also SENT, hardcoded in the config of every satellite,
 * embedded app and MCP client that integrated before the rename. Those callers
 * do not redeploy when the platform does.
 *
 * `canonicalPermission()` on the READ path (`claims.ts`) is too late: Better
 * Auth's oauth-provider validates the requested `scope` against
 * `client.scopes ?? opts.scopes` and HARD-FAILS long before any claim is built —
 * `/oauth2/authorize` redirects with `error=invalid_scope` (see
 * `@better-auth/oauth-provider/dist/index.mjs`, the `invalidScopes.length`
 * guard in `authorizeEndpoint`), and `/oauth2/token` + `/oauth2/register` throw
 * a 400 with the same code. Not a silent filter: the client gets an outright
 * refusal and its integration stops working.
 *
 * So the alias has to be applied to the REQUEST, at the module's Better Auth
 * boundary, before the plugin's own scope filter sees it — which is what
 * `canonicalizeScopeParam` + the guards-plugin hook do.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { oauthClient } from "@appstrate/db/schema";
import { user as userTable } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import oidcModule from "../../../index.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";

const app = getTestApp({ modules: [oidcModule] });

const REDIRECT_URI = "https://legacy-satellite.example.com/callback";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64url(new Uint8Array(digest));
}

/**
 * Register an application-level client the way the dashboard does. `scopes` is
 * what lands in `oauth_clients.scopes` — post-migration-0044 that column holds
 * the CANONICAL spelling, which is exactly why the legacy request has to be
 * rewritten rather than matched.
 */
async function registerClient(ctx: TestContext, scopes: string[]): Promise<string> {
  const res = await app.request("/api/oauth/clients", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify({
      level: "application",
      name: "Legacy Scope Satellite",
      redirectUris: [REDIRECT_URI],
      scopes,
      referencedApplicationId: ctx.defaultAppId,
      isFirstParty: false,
      allowSignup: true,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { clientId: string }).clientId;
}

/** Sign up an end-user and stamp the realm the token-mint guard expects. */
async function signUpEndUser(applicationId: string): Promise<string> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `legacy-scope-${crypto.randomUUID()}@satellite.example.com`,
      password: "Sup3rSecretPass!",
      name: "Legacy",
    }),
  });
  expect(res.status).toBe(200);
  const cookie = `better-auth.session_token=${
    (res.headers.get("set-cookie") ?? "").match(/better-auth\.session_token=([^;]+)/)![1]
  }`;
  const body = (await res.json()) as { user: { id: string } };
  await db
    .update(userTable)
    .set({ realm: `end_user:${applicationId}` })
    .where(eq(userTable.id, body.user.id));
  return cookie;
}

async function authorize(clientId: string, scope: string, cookie: string): Promise<URL> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const url =
    `/api/auth/oauth2/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope,
      state: base64url(crypto.getRandomValues(new Uint8Array(16))),
      code_challenge: await sha256Base64Url(verifier),
      code_challenge_method: "S256",
    }).toString();
  const res = await app.request(url, {
    method: "GET",
    headers: { cookie, accept: "text/html" },
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!, "http://localhost");
}

describe("#1177 compatibility — a client that still requests documents:read", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    ctx = await createTestContext({ orgSlug: "legacyscope" });
  });

  it("does not reject a legacy documents:read scope at /oauth2/authorize", async () => {
    // The client row holds the canonical spelling (migration 0044 rewrote it);
    // the CLIENT still sends the retired one. That mismatch is the whole bug.
    const clientId = await registerClient(ctx, ["openid", "profile", "files:read"]);
    const cookie = await signUpEndUser(ctx.defaultAppId);

    const location = await authorize(clientId, "openid documents:read", cookie);

    // A rejection redirects to the CLIENT's redirect_uri with an OAuth error.
    expect(location.searchParams.get("error")).toBeNull();
    expect(location.origin + location.pathname).not.toBe(REDIRECT_URI);
    // The happy path lands on the module's own consent page instead.
    expect(location.pathname).toBe("/api/oauth/consent");
    // …and the scope carried into consent (and from there into the grant) is
    // canonical, so `scopesToPermissions` grants `files:read` rather than
    // handing the user a consent screen for a resource that no longer exists.
    expect(location.searchParams.get("scope")).toBe("openid files:read");
  });

  it("still rejects a scope that is genuinely unknown", async () => {
    // The rewrite must not become a blanket accept — a typo or an escalation
    // attempt is still an `invalid_scope`.
    const clientId = await registerClient(ctx, ["openid", "profile", "files:read"]);
    const cookie = await signUpEndUser(ctx.defaultAppId);

    const location = await authorize(clientId, "openid superadmin:*", cookie);

    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("invalid_scope");
  });

  it("persists the canonical spelling when a legacy client re-registers", async () => {
    // `assertValidScopes` validated canonically but stored the caller's raw
    // string, so a re-registering legacy client re-introduced a `documents:`
    // row — breaking the invariant migration 0044 exists to establish, and
    // leaving the row un-migrated for good (0044 runs once).
    const clientId = await registerClient(ctx, ["openid", "profile", "documents:read"]);

    const [row] = await db
      .select({ scopes: oauthClient.scopes })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId));
    expect(row!.scopes).toBeTruthy();
    const stored = Array.isArray(row!.scopes)
      ? (row!.scopes as string[])
      : String(row!.scopes).split(/[ ,]+/);
    expect(stored).toContain("files:read");
    expect(stored).not.toContain("documents:read");
  });
});
