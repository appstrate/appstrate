// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the credential-proxy JWT bearer path.
 *
 * The core route `/api/credential-proxy/proxy` was API-key-only until the
 * remote-backed CLI work (docs/specs/REMOTE_CLI_EXECUTION_SPEC.md). These
 * tests pin the new contract:
 *
 *   1. A device-flow JWT minted by `POST /api/auth/cli/token` authenticates
 *      the caller on the proxy — the auth pipeline's OIDC strategy claims
 *      the request and the route's `ACCEPTED_AUTH_METHODS` allows
 *      `oauth2-instance`.
 *
 *   2. Cookie sessions remain rejected (drive-by CSRF threat model).
 *
 *   3. Garbage bearer values fall all the way through to the final
 *      `Invalid or missing session` 401, not silently to 500.
 *
 * We don't drive the request all the way to an upstream provider — that
 * is covered by `credential-proxy-injection.test.ts`. Here we only care
 * that the auth gate lets the right principals in, and that the session
 * binding is keyed on the namespaced `user:<id>` principal (not the raw
 * user id, so an API key and a JWT for the same underlying id cannot
 * share a cookie jar).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user as userTable, session as sessionTable } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestUser, createTestOrg } from "../../../../../../test/helpers/auth.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import oidcModule from "../../../index.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { ensureCliClient } from "../../../services/ensure-cli-client.ts";
import { deviceCode } from "../../../schema.ts";
import { overrideJwksResolver } from "../../../services/enduser-token.ts";

const app = getTestApp({ modules: [oidcModule] });

interface Principal {
  userId: string;
  cookie: string;
  orgId: string;
  applicationId: string;
  accessToken: string;
}

/**
 * Create a user, own-role org + default app, and mint a device-flow
 * JWT for that user. Returns everything a request needs to hit
 * `/api/credential-proxy/proxy`.
 */
async function createJwtPrincipal(): Promise<Principal> {
  const testUser = await createTestUser();

  // Platform realm is the default for BA's `databaseHooks.user.create.before`
  // but we assert it explicitly to match the cli-token-flow pattern — the
  // device-flow plugin refuses users in non-platform realms.
  await db.update(userTable).set({ realm: "platform" }).where(eq(userTable.id, testUser.id));
  await db
    .update(sessionTable)
    .set({ realm: "platform" })
    .where(eq(sessionTable.userId, testUser.id));

  // Org + owner membership + default application via the shared
  // helper — owners inherit `credential-proxy:call` from the role-grant
  // matrix.
  const { org, defaultAppId } = await createTestOrg(testUser.id);

  // Device-flow dance — code, approve, exchange.
  const codeRes = await app.request("/api/auth/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "appstrate-cli",
      scope: "openid profile email offline_access",
    }),
  });
  expect(codeRes.status).toBe(200);
  const code = (await codeRes.json()) as { device_code: string; user_code: string };

  const approveRes = await app.request("/api/auth/device/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: testUser.cookie },
    body: JSON.stringify({ userCode: code.user_code }),
  });
  expect(approveRes.status).toBe(200);

  await db
    .update(deviceCode)
    .set({ lastPolledAt: new Date(Date.now() - 10_000) })
    .where(eq(deviceCode.deviceCode, code.device_code));

  const tokenRes = await app.request("/api/auth/cli/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: code.device_code,
      client_id: "appstrate-cli",
    }),
  });
  expect(tokenRes.status).toBe(200);
  const tokens = (await tokenRes.json()) as { access_token: string };

  return {
    userId: testUser.id,
    cookie: testUser.cookie,
    orgId: org.id,
    applicationId: defaultAppId,
    accessToken: tokens.access_token,
  };
}

describe("POST /api/credential-proxy/proxy — auth gate", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwksResolver(null);
    await ensureCliClient();
  });

  it("accepts a device-flow JWT bearer (oauth2-instance) and reaches post-auth validation", async () => {
    const p = await createJwtPrincipal();

    // Omit X-Provider on purpose — a JWT that authenticated successfully
    // lands in the handler body and trips the explicit validation there.
    // If the auth pipeline rejected the JWT we would get 401 / 403
    // instead, never reaching the 400 branch.
    const res = await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${p.accessToken}`,
        "X-Application-Id": p.applicationId,
        "X-Org-Id": p.orgId,
        "X-Target": "https://example.test/echo",
        "X-Session-Id": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string; title?: string };
    const detail = body.detail ?? body.title ?? "";
    expect(detail).toMatch(/X-Provider/i);
  });

  it("rejects cookie sessions with 403 (CSRF threat model)", async () => {
    const p = await createJwtPrincipal();

    const res = await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Cookie: p.cookie,
        "X-Application-Id": p.applicationId,
        "X-Org-Id": p.orgId,
        "X-Provider": "@test/example",
        "X-Target": "https://example.test/echo",
        "X-Session-Id": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/auth method/i);
  });

  it("rejects an unknown bearer shape with 401 (falls through the OIDC strategy)", async () => {
    // Not a JWT, not an ask_ key — the OIDC strategy returns null, core
    // Bearer API-key path doesn't match either (no `ask_` prefix), the
    // cookie fallback fails to resolve a session.
    const res = await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: "Bearer not-a-real-token",
        "X-Application-Id": "app_x",
        "X-Provider": "@test/example",
        "X-Target": "https://example.test/echo",
        "X-Session-Id": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(401);
  });

  it("binds the session to the `user:<id>` namespace, not the raw id", async () => {
    // Regression guard: a namespaced principal keeps JWT sessions and
    // API-key sessions from sharing a cookie jar even if the underlying
    // identifiers collide. We prove it by reading the cache directly
    // after a successful proxy call.
    const p = await createJwtPrincipal();
    const sessionId = crypto.randomUUID();

    await app.request("/api/credential-proxy/proxy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${p.accessToken}`,
        "X-Application-Id": p.applicationId,
        "X-Org-Id": p.orgId,
        "X-Provider": "@missing/provider",
        "X-Target": "https://example.test/echo",
        "X-Session-Id": sessionId,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    const { getCache } = await import("../../../../../infra/index.ts");
    const cache = await getCache();
    const bound = await cache.get(`cp:session:${sessionId}`);
    expect(bound).toBe(`user:${p.userId}`);
  });
});
