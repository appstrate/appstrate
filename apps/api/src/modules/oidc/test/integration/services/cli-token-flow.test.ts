// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the CLI token endpoints introduced by issue #165:
 *
 *   POST /api/auth/cli/token
 *     grant_type=urn:ietf:params:oauth:grant-type:device_code
 *     grant_type=refresh_token   (rotation + reuse detection)
 *
 *   POST /api/auth/cli/revoke
 *     (family revocation)
 *
 * Covers:
 *   - Happy path: device_code → JWT + refresh pair; JWT verifies against
 *     the local JWKS and carries the expected instance-level claims
 *     (`actor_type=user`, `azp=appstrate-cli`, `email`, 15 min `exp`).
 *   - Refresh happy path: rotating refresh returns a fresh access +
 *     refresh and the old refresh is marked `used_at`.
 *   - Reuse detection: presenting the pre-rotation refresh token a
 *     second time triggers family revocation — every token in the same
 *     `family_id` has `revoked_at` set with reason `reuse`, and the
 *     newly-rotated token is also invalidated.
 *   - Expiry: a past `expires_at` on the refresh token fails with
 *     `invalid_grant`.
 *   - Client mismatch: a refresh token issued to client A cannot be
 *     rotated under client B.
 *   - Revoke: posting a refresh token to `/cli/revoke` flips the whole
 *     family to `revoked_at` with reason `logout`; subsequent rotation
 *     attempts fail with `invalid_grant`.
 *   - One-shot contract: the device_codes row is deleted on successful
 *     exchange, so a replay of the same device_code fails.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user as userTable, session as sessionTable } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestContext } from "../../../../../../test/helpers/auth.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import oidcModule from "../../../index.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { ensureCliClient } from "../../../services/ensure-cli-client.ts";
import { cliRefreshToken, deviceCode } from "../../../schema.ts";
import { _hashRefreshTokenForTesting } from "../../../services/cli-tokens.ts";
import {
  verifyEndUserAccessToken as verifyToken,
  overrideJwksResolver,
} from "../../../services/enduser-token.ts";

const app = getTestApp({ modules: [oidcModule] });

async function signUpPlatformUser(): Promise<{ cookie: string; userId: string }> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "cli-token@example.com",
      password: "Sup3rSecretPass!",
      name: "CLI Op",
    }),
  });
  expect(res.status).toBe(200);
  const match = (res.headers.get("set-cookie") ?? "").match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error("no session cookie");
  const cookie = `better-auth.session_token=${match[1]}`;
  const body = (await res.json()) as { user: { id: string } };
  // Platform realm — same contract as `device-flow.test.ts`.
  await db.update(userTable).set({ realm: "platform" }).where(eq(userTable.id, body.user.id));
  await db
    .update(sessionTable)
    .set({ realm: "platform" })
    .where(eq(sessionTable.userId, body.user.id));
  return { cookie, userId: body.user.id };
}

async function runDeviceFlow(
  cookie: string,
): Promise<{ deviceCodeValue: string; userCode: string }> {
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
  };
  const approveRes = await app.request("/api/auth/device/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ userCode: code.user_code }),
  });
  expect(approveRes.status).toBe(200);
  // Rewind lastPolledAt so /cli/token doesn't trip the polling throttle.
  await db
    .update(deviceCode)
    .set({ lastPolledAt: new Date(Date.now() - 10_000) })
    .where(eq(deviceCode.deviceCode, code.device_code));
  return { deviceCodeValue: code.device_code, userCode: code.user_code };
}

describe("POST /api/auth/cli/token — grant_type=device_code (issue #165)", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    // Fresh JWKS resolver — `enduser-token.ts` caches a resolver in
    // memory, and a prior test suite may have seeded it with keys from
    // a now-truncated `jwks` table.
    overrideJwksResolver(null);
    await createTestContext({ orgSlug: "clitoken" });
    await ensureCliClient();
  });

  it("exchanges an approved device_code for a signed JWT + rotating refresh token pair", async () => {
    const { cookie, userId } = await signUpPlatformUser();
    const { deviceCodeValue } = await runDeviceFlow(cookie);

    const res = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCodeValue,
        client_id: "appstrate-cli",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      refresh_expires_in: number;
      scope: string;
    };
    expect(body.token_type).toBe("Bearer");
    // 15 minute access token (issue #165).
    expect(body.expires_in).toBe(15 * 60);
    // 30 day refresh token.
    expect(body.refresh_expires_in).toBe(30 * 24 * 60 * 60);
    expect(body.access_token).toMatch(/^ey/);
    expect(body.refresh_token.length).toBeGreaterThan(32);
    expect(body.scope).toBe("openid profile email offline_access");

    // Access token verifies against the module's JWKS + carries the
    // expected instance-level claims.
    const claims = await verifyToken(body.access_token);
    expect(claims).not.toBeNull();
    expect(claims?.actorType).toBe("user");
    expect(claims?.authUserId).toBe(userId);
    expect(claims?.clientId).toBe("appstrate-cli");
    expect(claims?.email).toBe("cli-token@example.com");
    expect(claims?.scope).toBe("openid profile email offline_access");

    // PR #191 review — guard against BA's `jwt()` plugin silently
    // overriding the `exp`/`iat` we set in the payload. The server
    // promises a 15-minute TTL via `expires_in`; if the signed JWT
    // actually carries a different window, downstream RS-side
    // verification would either reject early or accept a too-long
    // replay window. Decode the raw JWT (no signature check needed —
    // `verifyToken` already passed) and assert the invariant.
    const [, payloadB64] = body.access_token.split(".");
    const rawPayload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8")) as {
      iat: number;
      exp: number;
    };
    expect(typeof rawPayload.iat).toBe("number");
    expect(typeof rawPayload.exp).toBe("number");
    expect(rawPayload.exp - rawPayload.iat).toBe(15 * 60);

    // Refresh token row is persisted with the expected shape.
    const hash = _hashRefreshTokenForTesting(body.refresh_token);
    const [row] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.tokenHash, hash))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.userId).toBe(userId);
    expect(row!.clientId).toBe("appstrate-cli");
    expect(row!.parentId).toBeNull(); // head of a fresh family
    expect(row!.usedAt).toBeNull();
    expect(row!.revokedAt).toBeNull();

    // Device code row MUST be gone (one-shot contract).
    const [deviceRow] = await db
      .select()
      .from(deviceCode)
      .where(eq(deviceCode.deviceCode, deviceCodeValue))
      .limit(1);
    expect(deviceRow).toBeUndefined();
  });

  it("returns authorization_pending when the user hasn't approved yet", async () => {
    await signUpPlatformUser();
    const codeRes = await app.request("/api/auth/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "appstrate-cli", scope: "openid" }),
    });
    const code = (await codeRes.json()) as { device_code: string };

    const res = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: "appstrate-cli",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("authorization_pending");
  });

  it("returns invalid_grant on an unknown device_code", async () => {
    const res = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "does-not-exist",
        client_id: "appstrate-cli",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("returns invalid_grant when the device_code belongs to a different client", async () => {
    const { cookie } = await signUpPlatformUser();
    const { deviceCodeValue } = await runDeviceFlow(cookie);

    const res = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCodeValue,
        client_id: "some-other-client", // bogus client
      }),
    });
    // `/cli/token` validates the client allowlist FIRST → `invalid_client`
    // is surfaced by `validateClientOrThrow` before the device-code
    // check. This protects against cross-client device_code theft.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_client");
  });

  it("enforces the one-shot contract: replay of the same device_code after success → invalid_grant", async () => {
    const { cookie } = await signUpPlatformUser();
    const { deviceCodeValue } = await runDeviceFlow(cookie);

    const first = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCodeValue,
        client_id: "appstrate-cli",
      }),
    });
    expect(first.status).toBe(200);

    const replay = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCodeValue,
        client_id: "appstrate-cli",
      }),
    });
    expect(replay.status).toBe(400);
    const body = (await replay.json()) as { error?: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("serializes concurrent device_code exchanges — at most one pair minted", async () => {
    // Regression guard against the TOCTOU race between the `status ===
    // "approved"` check and the one-shot `DELETE device_codes` sweep.
    // Two concurrent polls on the same device_code MUST NOT mint two
    // refresh-token pairs (RFC 8628 §3.5 one-shot contract).
    //
    // The split-transaction refactor (PGlite deadlock fix) allows two
    // outcomes depending on which racer wins the persist-tx lock:
    //   - One racer wins 200, the other hits `invalid_grant` because
    //     the device_codes row is already gone when it re-reads.
    //   - Under tight timing, BOTH racers hit `slow_down` (polling
    //     interval guard) or `invalid_grant` and return 400.
    // Either outcome preserves the security invariant that AT MOST
    // one refresh-token pair exists for a given device_code.
    const { cookie } = await signUpPlatformUser();
    const { deviceCodeValue } = await runDeviceFlow(cookie);

    const makeReq = () =>
      app.request("/api/auth/cli/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCodeValue,
          client_id: "appstrate-cli",
        }),
      });

    const [a, b] = await Promise.all([makeReq(), makeReq()]);
    // Both statuses are in the allowed set — either the happy split
    // [200, 400] or the stricter double-loss [400, 400].
    for (const res of [a, b]) {
      expect([200, 400]).toContain(res.status);
    }

    // Invariant #1: at most ONE refresh-token row (the winner's).
    const allRefresh = await db.select().from(cliRefreshToken);
    expect(allRefresh.length).toBeLessThanOrEqual(1);

    // Invariant #2: device_codes row is gone (or the two racers both
    // failed before deleting — either way, no usable row remains).
    const [deviceRow] = await db
      .select()
      .from(deviceCode)
      .where(eq(deviceCode.deviceCode, deviceCodeValue))
      .limit(1);
    // If a 200 was returned, the device_codes row MUST be gone.
    const anyWinner = a.status === 200 || b.status === 200;
    if (anyWinner) {
      expect(deviceRow).toBeUndefined();
      expect(allRefresh.length).toBe(1);
    }
  });
});

describe("POST /api/auth/cli/token — grant_type=refresh_token", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwksResolver(null);
    await createTestContext({ orgSlug: "cliref" });
    await ensureCliClient();
  });

  async function loginAndGetPair(): Promise<{
    userId: string;
    accessToken: string;
    refreshToken: string;
  }> {
    const { cookie, userId } = await signUpPlatformUser();
    const { deviceCodeValue } = await runDeviceFlow(cookie);
    const res = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCodeValue,
        client_id: "appstrate-cli",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
    };
    return { userId, accessToken: body.access_token, refreshToken: body.refresh_token };
  }

  it("rotates the refresh token and marks the previous one used_at", async () => {
    const { userId, refreshToken: first } = await loginAndGetPair();

    const rotateRes = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: first,
        client_id: "appstrate-cli",
      }),
    });
    expect(rotateRes.status).toBe(200);
    const body = (await rotateRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_expires_in: number;
    };
    expect(body.refresh_token).not.toBe(first);
    expect(body.expires_in).toBe(15 * 60);
    expect(body.refresh_expires_in).toBe(30 * 24 * 60 * 60);

    // Old row: used_at set, not revoked.
    const [oldRow] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.tokenHash, _hashRefreshTokenForTesting(first)))
      .limit(1);
    expect(oldRow).toBeDefined();
    expect(oldRow!.usedAt).not.toBeNull();
    expect(oldRow!.revokedAt).toBeNull();

    // New row: linked to old via parent_id, shared family_id.
    const [newRow] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.tokenHash, _hashRefreshTokenForTesting(body.refresh_token)))
      .limit(1);
    expect(newRow).toBeDefined();
    expect(newRow!.parentId).toBe(oldRow!.id);
    expect(newRow!.familyId).toBe(oldRow!.familyId);
    expect(newRow!.userId).toBe(userId);

    // New access token verifies cleanly.
    const claims = await verifyToken(body.access_token);
    expect(claims?.authUserId).toBe(userId);
  });

  it("re-narrows scope against the client's current scopes on rotation (PR #191 review)", async () => {
    // Scenario: a CLI login completes while the client declares four
    // scopes; an operator later removes `email` from the client
    // definition. The next refresh-token rotation MUST NOT continue to
    // emit `email` in the rotated JWT — the persisted row's scope
    // string reflects the old grant, but the JWT is authoritative at
    // mint time and must match the client's CURRENT surface.
    const { refreshToken: first } = await loginAndGetPair();

    const { oauthClient } = await import("../../../schema.ts");
    await db
      .update(oauthClient)
      .set({ scopes: ["openid", "profile", "offline_access"] }) // email removed
      .where(eq(oauthClient.clientId, "appstrate-cli"));

    const rotate = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: first,
        client_id: "appstrate-cli",
      }),
    });
    expect(rotate.status).toBe(200);
    const body = (await rotate.json()) as { access_token: string; scope: string };

    // Response echoes the narrowed grant (RFC 6749 §3.3: responses
    // MUST reflect what was actually granted when it differs from the
    // request).
    expect(body.scope).toBe("openid profile offline_access");
    expect(body.scope).not.toContain("email");

    // JWT payload carries the narrowed scope claim.
    const [, payloadB64] = body.access_token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8")) as {
      scope?: string;
    };
    expect(payload.scope).toBe("openid profile offline_access");
  });

  it("detects reuse and revokes the entire family (RFC 6819 §5.2.2.3)", async () => {
    const { refreshToken: first } = await loginAndGetPair();

    // First rotation — legitimate.
    const rotate1 = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: first,
        client_id: "appstrate-cli",
      }),
    });
    expect(rotate1.status).toBe(200);
    const body1 = (await rotate1.json()) as { refresh_token: string };

    // Second rotation on the same `first` token — this is the attack
    // pattern (stolen pre-rotation copy).
    const reuse = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: first,
        client_id: "appstrate-cli",
      }),
    });
    expect(reuse.status).toBe(400);
    const reuseBody = (await reuse.json()) as { error?: string };
    expect(reuseBody.error).toBe("invalid_grant");

    // Both rows (the original + the legitimate rotation) MUST now be
    // revoked with reason `reuse`.
    const [origRow] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.tokenHash, _hashRefreshTokenForTesting(first)))
      .limit(1);
    expect(origRow?.revokedAt).not.toBeNull();
    expect(origRow?.revokedReason).toBe("reuse");

    const [rotatedRow] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.tokenHash, _hashRefreshTokenForTesting(body1.refresh_token)))
      .limit(1);
    expect(rotatedRow?.revokedAt).not.toBeNull();
    expect(rotatedRow?.revokedReason).toBe("reuse");

    // Legit CLI trying to rotate the post-reuse-rotation token also fails.
    const retry = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: body1.refresh_token,
        client_id: "appstrate-cli",
      }),
    });
    expect(retry.status).toBe(400);
    const retryBody = (await retry.json()) as { error?: string };
    expect(retryBody.error).toBe("invalid_grant");
  });

  it("serializes concurrent rotations — both fail with invalid_grant, entire family revoked", async () => {
    // RFC 6819 §5.2.2.3 — two concurrent rotations of the same refresh
    // token is indistinguishable from a stolen-token-replay attack;
    // the correct response is to revoke the entire family and force
    // re-login. Prior implementation returned 200 to the winner with
    // tokens that were server-side-revoked immediately after; the
    // split-transaction refactor (PGlite deadlock fix) tightened the
    // story so both racers now surface the revocation synchronously:
    // the loser detects `used_at` is set → revokes family + throws
    // invalid_grant; the winner's persist-tx notices the family was
    // revoked between validate and persist → self-revokes its child +
    // throws invalid_grant. Net effect is identical to the old
    // behavior for the CLI (wipes credentials + re-auth prompt) but
    // the signal is immediate rather than one request later.
    const { refreshToken: first } = await loginAndGetPair();

    const makeReq = () =>
      app.request("/api/auth/cli/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: first,
          client_id: "appstrate-cli",
        }),
      });

    const [a, b] = await Promise.all([makeReq(), makeReq()]);
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    const aBody = (await a.json()) as { error?: string };
    const bBody = (await b.json()) as { error?: string };
    expect(aBody.error).toBe("invalid_grant");
    expect(bBody.error).toBe("invalid_grant");

    // Family: the parent (presented, now used_at) + the winner's child
    // row (inserted then self-revoked). Both share one family_id.
    const allInFamily = await db.select().from(cliRefreshToken);
    const familyIds = new Set(allInFamily.map((r) => r.familyId));
    expect(familyIds.size).toBe(1);
    expect(allInFamily.length).toBe(2);

    // Both rows MUST be revoked with reason=reuse — the loser's
    // revokeFamily sweep handles the parent; the winner's persist-tx
    // self-revoke handles the freshly-inserted child.
    for (const r of allInFamily) {
      expect(r.revokedAt).not.toBeNull();
      expect(r.revokedReason).toBe("reuse");
    }
  });

  it("rejects an unknown refresh token with invalid_grant", async () => {
    const res = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: "definitely-not-a-real-token",
        client_id: "appstrate-cli",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("rejects an expired refresh token with invalid_grant", async () => {
    const { refreshToken } = await loginAndGetPair();
    // Backdate the stored expiry so the row is past expires_at.
    await db
      .update(cliRefreshToken)
      .set({ expiresAt: new Date(Date.now() - 10_000) })
      .where(eq(cliRefreshToken.tokenHash, _hashRefreshTokenForTesting(refreshToken)));
    const res = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "appstrate-cli",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("missing device_code on device_code grant → invalid_request", async () => {
    const res = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: "appstrate-cli",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_request");
  });

  it("missing refresh_token on refresh_token grant → invalid_request", async () => {
    const res = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: "appstrate-cli",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_request");
  });

  it("unsupported grant_type → invalid_request", async () => {
    const res = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "password",
        client_id: "appstrate-cli",
      }),
    });
    // `/cli/token` never supports password grant; the guard should
    // surface invalid_request (not invalid_client — the client IS
    // known).
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_request");
  });
});

describe("POST /api/auth/cli/revoke", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwksResolver(null);
    await createTestContext({ orgSlug: "clirev" });
    await ensureCliClient();
  });

  async function loginAndGetRefresh(): Promise<string> {
    const { cookie } = await signUpPlatformUser();
    const { deviceCodeValue } = await runDeviceFlow(cookie);
    const res = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCodeValue,
        client_id: "appstrate-cli",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refresh_token: string };
    return body.refresh_token;
  }

  it("revokes the entire family with reason=logout and blocks subsequent rotation", async () => {
    const refreshToken = await loginAndGetRefresh();

    const revokeRes = await app.request("/api/auth/cli/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: refreshToken, client_id: "appstrate-cli" }),
    });
    expect(revokeRes.status).toBe(200);
    const body = (await revokeRes.json()) as { revoked: boolean };
    expect(body.revoked).toBe(true);

    const [row] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.tokenHash, _hashRefreshTokenForTesting(refreshToken)))
      .limit(1);
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.revokedReason).toBe("logout");

    // Rotation attempt on a revoked token → invalid_grant.
    const rotateRes = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "appstrate-cli",
      }),
    });
    expect(rotateRes.status).toBe(400);
    const rotateBody = (await rotateRes.json()) as { error?: string };
    expect(rotateBody.error).toBe("invalid_grant");
  });

  it("is idempotent — second call returns {revoked: true} without error (RFC 7009 §2.2)", async () => {
    const refreshToken = await loginAndGetRefresh();
    await app.request("/api/auth/cli/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: refreshToken, client_id: "appstrate-cli" }),
    });
    // The token plaintext is still the same string the client holds,
    // so the second call still finds the row — but the row is already
    // revoked so the UPDATE is a no-op. The response shape is uniform
    // per RFC 7009 §2.2 — a caller cannot distinguish first-revoke from
    // already-revoked through the response body.
    const second = await app.request("/api/auth/cli/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: refreshToken, client_id: "appstrate-cli" }),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { revoked: boolean };
    expect(body.revoked).toBe(true);
  });

  it("returns {revoked: true} uniformly for an unknown token (RFC 7009 §2.2 — no oracle)", async () => {
    const res = await app.request("/api/auth/cli/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "unknown", client_id: "appstrate-cli" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean };
    // RFC 7009 §2.2: the authorization server responds 200 for invalid
    // tokens too. We go further and return the same response shape so the
    // caller cannot probe token existence on the 256-bit plaintext space.
    expect(body.revoked).toBe(true);
  });

  it("rejects revocation of a token issued to a different client (cross-client defense)", async () => {
    const refreshToken = await loginAndGetRefresh();
    // A malicious actor registers their own CLI-grantable client and
    // calls revoke against the victim's token. The row is found but
    // the clientId mismatch causes `revokeRefreshToken` to short-circuit
    // server-side. The HTTP response is uniform per RFC 7009 §2.2 —
    // callers cannot distinguish "not yours" from "not found" or
    // "already revoked", all return 200 + `{ revoked: true }`. The
    // cross-client miss is only surfaced in the audit log (the
    // `cli.refresh_token.revoke.client_mismatch` warn event), so
    // operators can still spot a compromised token showing up from an
    // unexpected client id.
    const { prefixedId } = await import("../../../../../lib/ids.ts");
    const { oauthClient } = await import("../../../schema.ts");
    const attackerClientId = "attacker-cli";
    await db.insert(oauthClient).values({
      id: prefixedId("oac"),
      clientId: attackerClientId,
      clientSecret: null,
      name: "Attacker",
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
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      responseTypes: [],
      requirePKCE: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.request("/api/auth/cli/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: refreshToken, client_id: attackerClientId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean };
    // Uniform response (RFC 7009 §2.2) — the attacker gets the same
    // shape a legitimate revoke would produce, so they cannot probe
    // whether the token maps to a different client.
    expect(body.revoked).toBe(true);

    // Legitimate row is still usable.
    const [row] = await db
      .select()
      .from(cliRefreshToken)
      .where(and(eq(cliRefreshToken.tokenHash, _hashRefreshTokenForTesting(refreshToken))))
      .limit(1);
    expect(row?.revokedAt).toBeNull();
  });
});

describe("device-session metadata (issue #251)", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    overrideJwksResolver(null);
    await createTestContext({ orgSlug: "climeta" });
    await ensureCliClient();
  });

  // `TRUST_PROXY` defaults to `false` in the test env, so
  // `getClientIpFromRequest` returns `null` when reading from a test
  // request that carries no socket address — the cli-plugin layer
  // persists null directly so the dashboard renders an empty cell
  // (instead of a noise word). Tests that want a non-null `created_ip`
  // must therefore push an explicit `X-Forwarded-For` header AND run
  // with `TRUST_PROXY=1` so the resolver actually reads it. The current
  // suite asserts on the null vs non-null distinction.

  async function loginWithMetadata(headers: Record<string, string>): Promise<{
    refreshToken: string;
    familyId: string;
    headRowId: string;
  }> {
    const { cookie } = await signUpPlatformUser();
    const { deviceCodeValue } = await runDeviceFlow(cookie);
    const res = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCodeValue,
        client_id: "appstrate-cli",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refresh_token: string };
    const [row] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.tokenHash, _hashRefreshTokenForTesting(body.refresh_token)))
      .limit(1);
    expect(row).toBeDefined();
    return {
      refreshToken: body.refresh_token,
      familyId: row!.familyId,
      headRowId: row!.id,
    };
  }

  it("captures user_agent + device_name + created_ip on the head row at device-code exchange", async () => {
    const { headRowId } = await loginWithMetadata({
      "User-Agent": "appstrate-cli/2.4.0 (darwin arm64; node 20.11.1)",
      "X-Appstrate-Device-Name": "pierre's macbook",
      "X-Forwarded-For": "203.0.113.7",
    });

    const [row] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.id, headRowId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.parentId).toBeNull(); // confirm this is the head
    expect(row!.userAgent).toBe("appstrate-cli/2.4.0 (darwin arm64; node 20.11.1)");
    expect(row!.deviceName).toBe("pierre's macbook");
    // `TRUST_PROXY=false` (test default) → XFF ignored, resolver returns
    // `"unknown"`, normalized to `null` at the cli-plugin layer so the
    // dashboard doesn't render the sentinel as a real IP.
    expect(row!.createdIp).toBeNull();
    expect(row!.lastUsedAt).toBeNull();
    expect(row!.lastUsedIp).toBeNull();
  });

  it("clamps device_name to 120 chars and trims whitespace", async () => {
    const longName = "a".repeat(500);
    const { headRowId } = await loginWithMetadata({
      "X-Appstrate-Device-Name": `   ${longName}   `,
    });
    const [row] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.id, headRowId))
      .limit(1);
    expect(row?.deviceName?.length).toBe(120);
    expect(row?.deviceName).toMatch(/^a+$/);
  });

  it("treats empty/whitespace device_name as null", async () => {
    const { headRowId } = await loginWithMetadata({
      "X-Appstrate-Device-Name": "   ",
    });
    const [row] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.id, headRowId))
      .limit(1);
    expect(row?.deviceName).toBeNull();
  });

  it("updates last_used_at + last_used_ip on the head row when a child rotates", async () => {
    const { refreshToken, familyId, headRowId } = await loginWithMetadata({
      "User-Agent": "appstrate-cli/2.4.0",
    });

    const before = Date.now();
    const rotateRes = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "appstrate-cli",
      }),
    });
    expect(rotateRes.status).toBe(200);
    const after = Date.now();
    const body = (await rotateRes.json()) as { refresh_token: string };

    // Head row: last_used_* updated
    const [head] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.id, headRowId))
      .limit(1);
    expect(head?.lastUsedAt).not.toBeNull();
    const ts = new Date(head!.lastUsedAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);

    // Child row: NULL metadata (rotation rows stay light)
    const [child] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.tokenHash, _hashRefreshTokenForTesting(body.refresh_token)))
      .limit(1);
    expect(child).toBeDefined();
    expect(child!.parentId).toBe(headRowId);
    expect(child!.familyId).toBe(familyId);
    expect(child!.deviceName).toBeNull();
    expect(child!.userAgent).toBeNull();
    expect(child!.createdIp).toBeNull();
    expect(child!.lastUsedAt).toBeNull();
    expect(child!.lastUsedIp).toBeNull();
  });

  it("does not overwrite head user_agent or device_name on rotation (head-only-on-login contract)", async () => {
    const { refreshToken, headRowId } = await loginWithMetadata({
      "User-Agent": "appstrate-cli/2.4.0",
      "X-Appstrate-Device-Name": "original-name",
    });

    // Rotate with a *different* UA + a different (would-be) device-name header.
    // Per the contract these MUST NOT be re-captured — only `last_used_*` may
    // change on the head, otherwise a CLI could silently mutate its
    // declared identity through a refresh.
    const rotateRes = await app.request("/api/auth/cli/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "evil-cli/9.9.9",
        "X-Appstrate-Device-Name": "attacker-relabel",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "appstrate-cli",
      }),
    });
    expect(rotateRes.status).toBe(200);

    const [head] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.id, headRowId))
      .limit(1);
    expect(head?.userAgent).toBe("appstrate-cli/2.4.0");
    expect(head?.deviceName).toBe("original-name");
  });
});
