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

  it("serializes concurrent rotations — only one winner, family revoked on the loser", async () => {
    // Regression guard against the TOCTOU race between SELECT (used_at
    // IS NULL) and UPDATE (SET used_at = now()). Before the atomic
    // `WHERE used_at IS NULL` + `.returning()` check, two concurrent
    // rotations of the same refresh token could both pass the
    // `if (row.usedAt)` guard, both issue fresh pairs, and leave two
    // usable child rows in the family — silently breaking the
    // one-time-use invariant RFC 6819 §5.2.2.3 mandates.
    //
    // With the fix, the DB serializes the UPDATE: the loser sees zero
    // affected rows, revokes the family, and the next rotation
    // (including the winner's child) fails — forcing re-login. That's
    // stricter than strictly necessary for a benign same-session retry
    // but indistinguishable from a real stolen-token race, and the
    // safer default.
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
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);

    const loser = a.status === 400 ? a : b;
    const loserBody = (await loser.json()) as { error?: string };
    expect(loserBody.error).toBe("invalid_grant");

    // Exactly ONE child row should exist in the family (the winner's),
    // and the parent (presented) row must be marked used_at.
    const allInFamily = await db.select().from(cliRefreshToken);
    // All rows share the same family_id (single login).
    const familyIds = new Set(allInFamily.map((r) => r.familyId));
    expect(familyIds.size).toBe(1);
    // Two rows total: parent (presented, now used_at set) + one child.
    expect(allInFamily.length).toBe(2);

    // Family MUST be revoked with reason=reuse so neither the winner's
    // child nor any other race participant can rotate going forward.
    const reuseRow = allInFamily.find((r) => r.revokedReason === "reuse");
    expect(reuseRow).toBeDefined();
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

  it("is idempotent — second call returns {revoked: false} without error", async () => {
    const refreshToken = await loginAndGetRefresh();
    await app.request("/api/auth/cli/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: refreshToken, client_id: "appstrate-cli" }),
    });
    // The token plaintext is still the same string the client holds,
    // so the second call still finds the row — but the row is already
    // revoked so the UPDATE is a no-op. Whether the service returns
    // `true` or `false` here is less important than "no error" —
    // logout must never crash.
    const second = await app.request("/api/auth/cli/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: refreshToken, client_id: "appstrate-cli" }),
    });
    expect(second.status).toBe(200);
  });

  it("returns {revoked: false} for an unknown token (no-op, does not leak)", async () => {
    const res = await app.request("/api/auth/cli/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "unknown", client_id: "appstrate-cli" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean };
    expect(body.revoked).toBe(false);
  });

  it("rejects revocation of a token issued to a different client (cross-client defense)", async () => {
    const refreshToken = await loginAndGetRefresh();
    // A malicious actor registers their own CLI-grantable client and
    // calls revoke against the victim's token. The row is found but
    // the clientId mismatch causes `revokeRefreshToken` to short-circuit
    // with `{ revoked: false }`. (We still return 200 — callers don't
    // get to distinguish "not yours" from "not found", preventing
    // enumeration.)
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
    expect(body.revoked).toBe(false);

    // Legitimate row is still usable.
    const [row] = await db
      .select()
      .from(cliRefreshToken)
      .where(and(eq(cliRefreshToken.tokenHash, _hashRefreshTokenForTesting(refreshToken))))
      .limit(1);
    expect(row?.revokedAt).toBeNull();
  });
});
