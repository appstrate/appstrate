// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end integration for the RFC 8628 device-authorization grant
 * wired by BA's `deviceAuthorization()` plugin.
 *
 * Scope: the happy path one level above the realm-only regression in
 * `device-flow-realm.test.ts` — covers the three RFC endpoints (code →
 * approve → token) as the CLI will use them. The BA plugin returns a
 * session token (not a JWT); this test asserts that shape and does NOT
 * try to verify a JWT against `/jwks.json` — those assumptions belong to
 * the classic `/oauth2/token` pipeline, not the device grant (see
 * `docs/specs/cli-preflight-results.md` § PF-3 for the rationale).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user as userTable, session as sessionTable } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestContext } from "../../../../../../test/helpers/auth.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import oidcModule from "../../../index.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { ensureCliClient } from "../../../services/ensure-cli-client.ts";
import { deviceCode } from "../../../schema.ts";

const app = getTestApp({ modules: [oidcModule] });

async function signUpPlatformUser(): Promise<{ cookie: string; userId: string }> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "operator@example.com",
      password: "Sup3rSecretPass!",
      name: "Op",
    }),
  });
  expect(res.status).toBe(200);
  const match = (res.headers.get("set-cookie") ?? "").match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error("no session cookie");
  const cookie = `better-auth.session_token=${match[1]}`;
  const body = (await res.json()) as { user: { id: string } };
  // Platform realm (default for dashboard signup without an OIDC
  // pending-client cookie) — set it explicitly to guard against any
  // future default change.
  await db.update(userTable).set({ realm: "platform" }).where(eq(userTable.id, body.user.id));
  await db
    .update(sessionTable)
    .set({ realm: "platform" })
    .where(eq(sessionTable.userId, body.user.id));
  return { cookie, userId: body.user.id };
}

describe("device-flow happy path", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    await createTestContext({ orgSlug: "devflowhappy" });
    await ensureCliClient();
  });

  it("issues device_code + user_code → approves → mints access_token", async () => {
    const { cookie } = await signUpPlatformUser();

    // 1. Request a device code (no auth required at `/device/code`).
    const codeRes = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: "appstrate-cli",
        scope: "openid profile email offline_access",
      }),
    });
    expect(codeRes.status).toBe(200);
    const code = (await codeRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
    expect(code.device_code).toBeTruthy();
    expect(code.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
    expect(code.verification_uri).toContain("/activate");
    expect(code.expires_in).toBe(600);
    expect(code.interval).toBe(5);

    // 2. Poll before approval → authorization_pending.
    const pendingRes = await app.request("/api/auth/device/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: "appstrate-cli",
      }),
    });
    expect(pendingRes.status).toBe(400);
    const pendingBody = (await pendingRes.json()) as { error?: string };
    expect(pendingBody.error).toBe("authorization_pending");

    // 3. User approves with their platform-realm BA session.
    const approveRes = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ userCode: code.user_code }),
    });
    expect(approveRes.status).toBe(200);

    // 4. Rewind `lastPolledAt` so the next poll doesn't trip BA's RFC
    //    8628 §5.5 `slow_down` throttle (polling inside the 5s interval
    //    returns 400 even once the code is approved). Production CLIs
    //    naturally wait; tests can't afford the delay.
    await db
      .update(deviceCode)
      .set({ lastPolledAt: new Date(Date.now() - 10_000) })
      .where(eq(deviceCode.deviceCode, code.device_code));

    // 5. Poll again → access_token issued.
    const tokenRes = await app.request("/api/auth/device/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: "appstrate-cli",
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBeGreaterThan(0);

    // Device code row deleted by BA after successful mint.
    const [rowAfter] = await db
      .select()
      .from(deviceCode)
      .where(eq(deviceCode.deviceCode, code.device_code))
      .limit(1);
    expect(rowAfter).toBeUndefined();
  });

  it("accepts application/x-www-form-urlencoded at /device/code + /device/token (RFC 8628 §3.2/§3.4)", async () => {
    const { cookie } = await signUpPlatformUser();

    // /device/code with form-urlencoded body — the platform-level shim
    // rewrites it to JSON before Better Auth's deviceAuthorization()
    // plugin sees the request.
    const codeRes = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "appstrate-cli",
        scope: "openid profile email offline_access",
      }).toString(),
    });
    expect(codeRes.status).toBe(200);
    const code = (await codeRes.json()) as {
      device_code: string;
      user_code: string;
    };
    expect(code.device_code).toBeTruthy();

    // Approve with the platform user's session so the next /device/token
    // call returns the access token (not authorization_pending).
    const approveRes = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ userCode: code.user_code }),
    });
    expect(approveRes.status).toBe(200);

    // Rewind lastPolledAt so the next poll doesn't trip the §5.5 slow_down
    // throttle — same rationale as the happy-path test.
    await db
      .update(deviceCode)
      .set({ lastPolledAt: new Date(Date.now() - 10_000) })
      .where(eq(deviceCode.deviceCode, code.device_code));

    // /device/token with form-urlencoded body.
    const tokenRes = await app.request("/api/auth/device/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: "appstrate-cli",
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
    };
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.token_type).toBe("Bearer");
  });

  it("rejects unknown client_id with invalid_client", async () => {
    const res = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "does-not-exist" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_client");
  });

  it("rejects replay of a consumed device_code on /device/token", async () => {
    // Regression for the RFC 8628 §3.5 one-shot contract: a device_code
    // that has already been exchanged for an access_token MUST NOT be
    // exchangeable again. BA's `deviceAuthorization()` plugin deletes
    // the row on successful mint, so a second poll hits the
    // unknown-code path — which MUST return `invalid_grant` (or
    // `expired_token`), never 200 with a fresh token. Without this
    // test a regression that stopped deleting the row (or that flipped
    // status back to `pending` on completion) would ship silently.
    const { cookie } = await signUpPlatformUser();
    const codeRes = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "appstrate-cli", scope: "openid" }),
    });
    expect(codeRes.status).toBe(200);
    const code = (await codeRes.json()) as { device_code: string; user_code: string };

    const approveRes = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ userCode: code.user_code }),
    });
    expect(approveRes.status).toBe(200);

    await db
      .update(deviceCode)
      .set({ lastPolledAt: new Date(Date.now() - 10_000) })
      .where(eq(deviceCode.deviceCode, code.device_code));

    // First exchange → token minted, row deleted.
    const first = await app.request("/api/auth/device/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: "appstrate-cli",
      }),
    });
    expect(first.status).toBe(200);
    // Assert the happy path actually produced a token — otherwise a
    // regression where `/device/token` never mints on any call would
    // make the replay check below pass vacuously (both calls fail for
    // the same reason, confirming nothing about replay semantics).
    const firstBody = (await first.json()) as { access_token?: string };
    expect(firstBody.access_token).toBeTruthy();

    // Second exchange on the same device_code → row is gone, must fail.
    const replay = await app.request("/api/auth/device/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: "appstrate-cli",
      }),
    });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.status).toBeLessThan(500);
    const replayBody = (await replay.json()) as { error?: string; access_token?: string };
    expect(replayBody.access_token).toBeUndefined();
    expect(["invalid_grant", "expired_token", "invalid_request"]).toContain(replayBody.error ?? "");
  });

  it("rejects /device/token when client_id does not match the device_code's client", async () => {
    // Regression for cross-client exchange after approval: the
    // device_code row is FK-bound to a single `client_id`, and BA's
    // `/device/token` handler verifies the incoming `client_id` matches
    // that row. An attacker who registers their own OAuth client and
    // discovers a victim's `device_code` MUST NOT be able to mint a
    // token against their own client. Without this test a future
    // regression in BA's exchange handler (or in a local patch) could
    // quietly allow cross-client minting — and the realm guard only
    // fires on `/device/approve`, not on `/device/token`.
    const { cookie } = await signUpPlatformUser();

    // Seed a second device-flow-capable client.
    const { prefixedId } = await import("../../../../../lib/ids.ts");
    const { oauthClient } = await import("../../../schema.ts");
    const attackerClientId = "attacker-cli";
    await db.insert(oauthClient).values({
      id: prefixedId("oac"),
      clientId: attackerClientId,
      clientSecret: null,
      name: "Attacker CLI",
      redirectUris: [],
      postLogoutRedirectUris: [],
      scopes: ["openid"],
      level: "instance",
      metadata: JSON.stringify({ level: "instance", clientId: attackerClientId }),
      skipConsent: true,
      allowSignup: false,
      signupRole: "member",
      disabled: false,
      type: "native",
      public: true,
      tokenEndpointAuthMethod: "none",
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code"],
      responseTypes: [],
      requirePKCE: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Victim initiates against the legitimate CLI client.
    const codeRes = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "appstrate-cli", scope: "openid" }),
    });
    expect(codeRes.status).toBe(200);
    const code = (await codeRes.json()) as { device_code: string; user_code: string };

    // Victim approves.
    const approveRes = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ userCode: code.user_code }),
    });
    expect(approveRes.status).toBe(200);

    await db
      .update(deviceCode)
      .set({ lastPolledAt: new Date(Date.now() - 10_000) })
      .where(eq(deviceCode.deviceCode, code.device_code));

    // Attacker attempts to exchange the code against *their* client_id.
    const crossExchange = await app.request("/api/auth/device/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: attackerClientId,
      }),
    });
    expect(crossExchange.status).toBeGreaterThanOrEqual(400);
    expect(crossExchange.status).toBeLessThan(500);
    const body = (await crossExchange.json()) as { error?: string; access_token?: string };
    expect(body.access_token).toBeUndefined();
    expect(["invalid_grant", "invalid_client", "invalid_request"]).toContain(body.error ?? "");
  });

  it("rejects a client without the device_code grant type", async () => {
    // Insert a minimal org-level client without the device grant and
    // verify it's refused.
    const { prefixedId } = await import("../../../../../lib/ids.ts");
    const { oauthClient } = await import("../../../schema.ts");
    await db.insert(oauthClient).values({
      id: prefixedId("oac"),
      clientId: "no-device-grant",
      clientSecret: null,
      name: "No Device Grant",
      redirectUris: ["https://e.example.com/cb"],
      postLogoutRedirectUris: [],
      scopes: ["openid"],
      level: "instance",
      metadata: JSON.stringify({ level: "instance", clientId: "no-device-grant" }),
      skipConsent: false,
      allowSignup: false,
      signupRole: "member",
      disabled: false,
      type: "web",
      public: true,
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      requirePKCE: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "no-device-grant" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_client");
  });
});
