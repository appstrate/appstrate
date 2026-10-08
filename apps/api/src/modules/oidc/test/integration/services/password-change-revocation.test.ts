// SPDX-License-Identifier: Apache-2.0

/**
 * Changing or resetting a password reaches what ending a session does not:
 * an OAuth refresh token issued with `offline_access` (an MCP client's here),
 * an opaque OAuth access token, a CLI session family, which is bound to no
 * session, and a device code already approved but not yet exchanged. Each path that
 * changes or resets a password is driven end to end (`/api/auth/change-password`,
 * `/api/auth/reset-password`, the hosted `/api/oauth/reset-password` page)
 * against two browser sessions, a CLI login and an MCP client. The platform-only
 * half (sessions) is `test/integration/auth/password-change-sessions.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { deviceCode, oauthAccessToken, oauthResource } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestOrg, createTestUser } from "../../../../../../test/helpers/auth.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import {
  enableSmtpForSuite,
  captureMails,
  firstLink,
} from "../../../../../../test/helpers/smtp.ts";
import {
  registerProtectedResourceFamily,
  resetProtectedResources,
  snapshotProtectedResources,
  restoreProtectedResources,
} from "../../../../../lib/protected-resources.ts";
import { getMcpOrgResourceUri, orgIdFromMcpAudience } from "../../../../../lib/audiences.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { ensureCliClient } from "../../../services/ensure-cli-client.ts";
import { createClient, _resetClientCache } from "../../../services/oauth-admin.ts";
import { upsertSmtpConfig, _clearSmtpCacheForTesting } from "../../../services/smtp.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

const PASSWORD = "TestPassword123!";
const NEW_PASSWORD = "BrandNewPassword456!";
const MCP_REDIRECT_URI = "http://localhost:9916/callback";

// The protected-resource registry is a process-wide singleton shared with the
// live app: snapshot it before this file replaces the MCP family, restore after.
let protectedResourcesSnapshot: ReturnType<typeof snapshotProtectedResources>;
beforeAll(() => {
  protectedResourcesSnapshot = snapshotProtectedResources();
});
afterAll(() => {
  restoreProtectedResources(protectedResourcesSnapshot);
});

function postAuth(path: string, body: unknown, cookie?: string): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

function sessionCookie(res: Response): string {
  const token = /better-auth\.session_token=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  if (!token) throw new Error("no session cookie");
  return `better-auth.session_token=${token[1]}`;
}

async function profileStatus(cookie: string): Promise<number> {
  return (await app.request("/api/profile", { headers: { Cookie: cookie } })).status;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ─── CLI: device flow → refresh token ────────────────────────────────────────

/** A device code claimed and approved by the session in `cookie`, ready to exchange. */
async function approveDeviceCode(cookie: string): Promise<string> {
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
  await app.request(`/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`, {
    headers: { Cookie: cookie },
  });
  const approve = await postAuth("/device/approve", { userCode: code.user_code }, cookie);
  expect(approve.status).toBe(200);
  await db
    .update(deviceCode)
    .set({ lastPolledAt: new Date(Date.now() - 10_000) })
    .where(eq(deviceCode.deviceCode, code.device_code));
  return code.device_code;
}

function exchangeDeviceCode(code: string): Promise<Response> {
  return postAuth("/cli/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: code,
    client_id: "appstrate-cli",
  });
}

async function loginCli(cookie: string): Promise<string> {
  const tokenRes = await exchangeDeviceCode(await approveDeviceCode(cookie));
  expect(tokenRes.status).toBe(200);
  return ((await tokenRes.json()) as { refresh_token: string }).refresh_token;
}

function refreshCli(refreshToken: string): Promise<Response> {
  return postAuth("/cli/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: "appstrate-cli",
  });
}

// ─── MCP client: DCR + authorization code → offline_access refresh token ─────

interface McpGrant {
  clientId: string;
  resource: string;
  refreshToken: string;
}

async function authorizeMcpClient(cookie: string, resource: string): Promise<McpGrant> {
  const registered = await app.request("/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "MCP client",
      redirect_uris: [MCP_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect([200, 201]).toContain(registered.status);
  const clientId = String(((await registered.json()) as { client_id: string }).client_id);

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const authorizeQuery = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: MCP_REDIRECT_URI,
    scope: "mcp:read mcp:invoke offline_access",
    state: "password-change",
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
    resource,
  });
  const authorized = await app.request(`/api/auth/oauth2/authorize?${authorizeQuery}`, {
    headers: { cookie, accept: "text/html" },
    redirect: "manual",
  });
  expect(authorized.status).toBe(302);
  const consentUrl = new URL(authorized.headers.get("location")!, "http://localhost");
  expect(consentUrl.searchParams.get("error")).toBeNull();
  expect(consentUrl.pathname).toBe("/api/oauth/consent");

  const consentPage = await app.request(consentUrl.pathname + consentUrl.search, {
    headers: { cookie, accept: "text/html" },
  });
  const csrfCookie = (consentPage.headers.get("set-cookie") ?? "")
    .split(",")
    .map((c) => c.trim())
    .find((c) => c.startsWith("oidc_csrf="))!
    .split(";")[0]!;
  const csrfToken = (await consentPage.text()).match(/name="_csrf" value="([^"]+)"/)![1]!;
  const consented = await app.request(consentUrl.pathname + consentUrl.search, {
    method: "POST",
    headers: {
      cookie: `${cookie}; ${csrfCookie}`,
      "Content-Type": "application/x-www-form-urlencoded",
      accept: "application/json",
      origin: "http://localhost:3000",
    },
    body: new URLSearchParams({ _csrf: csrfToken, accept: "true" }).toString(),
    redirect: "manual",
  });
  const location = consented.headers.get("location");
  const callback = location
    ? new URL(location, MCP_REDIRECT_URI)
    : new URL(String(((await consented.json()) as { url?: string }).url));
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenRes = await app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      client_id: clientId,
      redirect_uri: MCP_REDIRECT_URI,
      code_verifier: verifier,
      resource,
    }).toString(),
  });
  expect(tokenRes.status).toBe(200);
  const refreshToken = ((await tokenRes.json()) as { refresh_token?: string }).refresh_token;
  expect(typeof refreshToken).toBe("string");
  return { clientId, resource, refreshToken: refreshToken! };
}

function refreshMcp(grant: McpGrant): Promise<Response> {
  return Promise.resolve(
    app.request("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: grant.refreshToken,
        client_id: grant.clientId,
        resource: grant.resource,
      }).toString(),
    }),
  );
}

// ─── Arrange: one account signed in four ways ────────────────────────────────

interface SignedInEverywhere {
  email: string;
  spaceId: string;
  sessionA: string;
  sessionB: string;
  cliRefreshToken: string;
  /** Approved by session B, not yet exchanged. */
  approvedDeviceCode: string;
  mcp: McpGrant;
  /** An opaque access token row, the kind introspection answers from. */
  opaqueAccessTokenId: string;
}

let orgResource: string | null = null;

async function signInEverywhere(): Promise<SignedInEverywhere> {
  const user = await createTestUser({ emailVerified: true, password: PASSWORD });
  const { org, defaultSpaceId } = await createTestOrg(user.id);
  const resource = getMcpOrgResourceUri(org.id);
  orgResource = resource;
  await db
    .insert(oauthResource)
    .values({ id: crypto.randomUUID(), identifier: resource, name: "MCP endpoint" })
    .onConflictDoNothing({ target: oauthResource.identifier });

  const signIn = await postAuth("/sign-in/email", { email: user.email, password: PASSWORD });
  expect(signIn.status).toBe(200);
  const sessionB = sessionCookie(signIn);

  // Each credential is used once before the change, so a failure afterwards
  // can only come from the change. Both rotate: keep the token handed back.
  const cliRotated = await refreshCli(await loginCli(sessionB));
  expect(cliRotated.status).toBe(200);
  const cliRefreshToken = ((await cliRotated.json()) as { refresh_token: string }).refresh_token;

  const grant = await authorizeMcpClient(sessionB, resource);
  const mcpRotated = await refreshMcp(grant);
  expect(mcpRotated.status).toBe(200);
  const rotatedMcp = ((await mcpRotated.json()) as { refresh_token?: string }).refresh_token;
  const mcp = { ...grant, refreshToken: rotatedMcp ?? grant.refreshToken };
  const opaqueAccessTokenId = crypto.randomUUID();
  await db.insert(oauthAccessToken).values({
    id: opaqueAccessTokenId,
    token: crypto.randomUUID(),
    clientId: grant.clientId,
    userId: user.id,
    scopes: ["mcp:read"],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const approvedDeviceCode = await approveDeviceCode(sessionB);

  expect(await profileStatus(user.cookie)).toBe(200);
  expect(await profileStatus(sessionB)).toBe(200);
  return {
    email: user.email,
    spaceId: defaultSpaceId,
    sessionA: user.cookie,
    sessionB,
    cliRefreshToken,
    approvedDeviceCode,
    mcp,
    opaqueAccessTokenId,
  };
}

async function expectGrantRefused(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error?: string }).error).toBe("invalid_grant");
}

/** Everything but the browser sessions, which each case checks itself. */
async function expectTokensRevoked(access: SignedInEverywhere): Promise<void> {
  await expectGrantRefused(await refreshCli(access.cliRefreshToken));
  await expectGrantRefused(await exchangeDeviceCode(access.approvedDeviceCode));
  await expectGrantRefused(await refreshMcp(access.mcp));
  const [opaque] = await db
    .select({ revoked: oauthAccessToken.revoked })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.id, access.opaqueAccessTokenId));
  expect(opaque?.revoked).toBeInstanceOf(Date);
}

async function resetToken(email: string): Promise<string> {
  const [mail] = await captureMails(async () => {
    const res = await postAuth("/request-password-reset", { email, redirectTo: "/reset-password" });
    expect(res.status).toBe(200);
  });
  return firstLink(mail!).pathname.split("/").pop()!;
}

describe("a password change or reset revokes the account's other access", () => {
  // Reset links leave by mail; sign-in then requires a verified address.
  enableSmtpForSuite();

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    _resetClientCache();
    _clearSmtpCacheForTesting();
    await ensureCliClient();
    resetProtectedResources();
    registerProtectedResourceFamily({
      prefix: "/api/mcp/o",
      deriveUri: (path) => {
        const orgId = path.slice("/api/mcp/o/".length).split("/")[0];
        return orgId ? getMcpOrgResourceUri(orgId) : undefined;
      },
      ownsUri: (uri) => orgIdFromMcpAudience(uri) !== undefined,
    });
  });

  // `oauth_resources` sits outside `truncateAll` (see `oidc/test/tables.ts`).
  afterEach(async () => {
    if (orgResource) {
      await db.delete(oauthResource).where(eq(oauthResource.identifier, orgResource));
    }
    orgResource = null;
  });

  it("a change keeps the session that made it and revokes everything else", async () => {
    const access = await signInEverywhere();

    const res = await postAuth(
      "/change-password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      access.sessionA,
    );

    expect(res.status).toBe(200);
    expect(await profileStatus(access.sessionA)).toBe(200);
    expect(await profileStatus(access.sessionB)).toBe(401);
    await expectTokensRevoked(access);
  });

  it("a reset through Better Auth revokes every session and token", async () => {
    const access = await signInEverywhere();
    const token = await resetToken(access.email);

    const res = await postAuth("/reset-password", { token, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(await profileStatus(access.sessionA)).toBe(401);
    expect(await profileStatus(access.sessionB)).toBe(401);
    await expectTokensRevoked(access);
  });

  it("a reset on the hosted page revokes every session and token", async () => {
    const access = await signInEverywhere();
    // The hosted page serves a space client whose space has its own transport.
    const client = await createClient({
      level: "space",
      name: "Hosted pages",
      redirectUris: ["https://acme.example.com/oauth/callback"],
      referencedSpaceId: access.spaceId,
    });
    await upsertSmtpConfig(access.spaceId, {
      host: "__test_json__",
      port: 587,
      username: "u",
      pass: "p",
      fromAddress: `no-reply@${access.spaceId}.test`,
      fromName: "Tenant",
    });
    const token = await resetToken(access.email);
    const qs = `?client_id=${encodeURIComponent(client.clientId)}&state=s`;
    const form = await app.request(
      `/api/oauth/reset-password${qs}&token=${encodeURIComponent(token)}`,
    );
    expect(form.status).toBe(200);
    const csrfCookie = (form.headers.get("set-cookie") ?? "").split(";")[0]!;
    const csrfToken = (await form.text()).match(/name="_csrf" value="([^"]+)"/)![1]!;

    const res = await app.request(`/api/oauth/reset-password${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: csrfCookie },
      body: new URLSearchParams({
        _csrf: csrfToken,
        token,
        password: NEW_PASSWORD,
        password_confirm: NEW_PASSWORD,
      }).toString(),
    });

    expect(res.status).toBe(200);
    expect(await profileStatus(access.sessionA)).toBe(401);
    expect(await profileStatus(access.sessionB)).toBe(401);
    await expectTokensRevoked(access);
  });
});
