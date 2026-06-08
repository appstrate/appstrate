// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 8252 §7.3 loopback redirect port-flexibility for native MCP clients.
 *
 * A native client (Claude Code) registers a fixed loopback redirect — e.g.
 * `http://localhost/callback` (its CIMD document declares exactly
 * `["http://localhost/callback","http://127.0.0.1/callback"]`) — but at runtime
 * listens on an ephemeral port and sends `http://localhost:<port>/callback`.
 * The authorization server MUST match these ignoring the port.
 *
 * Better Auth's `findRegisteredRedirectUri` applied the port-flexible match only
 * when the registered host was a loopback IP *literal* (`isLoopbackIP`), which
 * excludes the literal name `localhost` — so `http://localhost/callback` failed
 * to match `http://localhost:63785/callback` and the authorize step returned
 * `invalid_redirect`. We patch the plugin to use `isLoopbackHost` (which
 * includes `localhost`). This test locks in the fix.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { createTestContext, type TestContext } from "../../../../../../test/helpers/auth.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

/** Register a public native client whose only redirect is a port-less loopback. */
async function registerLoopbackClient(redirectUri: string): Promise<string> {
  const res = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Native loopback client",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid profile email offline_access",
    }),
  });
  expect([200, 201]).toContain(res.status);
  return String(((await res.json()) as { client_id: string }).client_id);
}

async function authorizeRedirectLocation(
  clientId: string,
  cookie: string,
  redirectUri: string,
): Promise<string> {
  const url =
    `/api/auth/oauth2/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access",
      state: "xyz",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    }).toString();
  const res = await app.request(url, {
    headers: { cookie, accept: "text/html" },
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  return res.headers.get("location") ?? "";
}

describe("RFC 8252 loopback redirect port-flexibility", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    ctx = await createTestContext({ orgSlug: "loopback" });
  });

  it("matches an ephemeral-port localhost redirect against a port-less registration", async () => {
    const clientId = await registerLoopbackClient("http://localhost/callback");
    // The runtime redirect carries an ephemeral port the registration can't know.
    const location = await authorizeRedirectLocation(
      clientId,
      ctx.cookie,
      "http://localhost:63785/callback",
    );
    // A successful match routes to the consent screen; the bug routed to the
    // server error page with error=invalid_redirect.
    expect(location).not.toContain("invalid_redirect");
    expect(new URL(location, "http://localhost").pathname).toBe("/api/oauth/consent");
  });

  it("still matches a 127.0.0.1 ephemeral-port redirect against a 127.0.0.1 registration", async () => {
    const clientId = await registerLoopbackClient("http://127.0.0.1/callback");
    const location = await authorizeRedirectLocation(
      clientId,
      ctx.cookie,
      "http://127.0.0.1:54321/callback",
    );
    expect(location).not.toContain("invalid_redirect");
    expect(new URL(location, "http://localhost").pathname).toBe("/api/oauth/consent");
  });

  it("still enforces path: a loopback redirect with a different path is rejected", async () => {
    const clientId = await registerLoopbackClient("http://localhost/callback");
    // Same loopback host (passes the HTTP-loopback gate) but a different path →
    // port-flexibility must NOT relax the path check.
    const location = await authorizeRedirectLocation(
      clientId,
      ctx.cookie,
      "http://localhost:63785/evil",
    );
    expect(location).toContain("invalid_redirect");
  });
});
