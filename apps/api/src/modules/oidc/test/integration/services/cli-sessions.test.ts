// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the dashboard-facing CLI session endpoints (issue #251):
 *
 *   GET  /api/auth/cli/sessions
 *   POST /api/auth/cli/sessions/revoke      body: { familyId }
 *   POST /api/auth/cli/sessions/revoke-all
 *
 * Covers:
 *   - List shape — head-of-family rows only, sorted by last activity, with
 *     metadata captured from the device-code exchange.
 *   - Auth gating — cookie required; unauthenticated requests fail.
 *   - Per-user scoping — user A cannot see / revoke user B's sessions.
 *   - Single revocation — flips `revoked_reason='user_revoked'` on the
 *     entire family, idempotent on the second call.
 *   - Bulk revocation — `revokeCount` matches the number of distinct
 *     families newly revoked, ignores already-revoked families.
 *   - Active filter — expired families are excluded from the listing
 *     even if `revoked_at IS NULL`.
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

const app = getTestApp({ modules: [oidcModule] });

interface SignupResult {
  cookie: string;
  userId: string;
}

async function signUp(email: string, name: string): Promise<SignupResult> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "Sup3rSecretPass!",
      name,
    }),
  });
  expect(res.status).toBe(200);
  const match = (res.headers.get("set-cookie") ?? "").match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error("no session cookie");
  const cookie = `better-auth.session_token=${match[1]}`;
  const body = (await res.json()) as { user: { id: string } };
  await db.update(userTable).set({ realm: "platform" }).where(eq(userTable.id, body.user.id));
  await db
    .update(sessionTable)
    .set({ realm: "platform" })
    .where(eq(sessionTable.userId, body.user.id));
  return { cookie, userId: body.user.id };
}

async function loginCliFor(
  cookie: string,
  headers: Record<string, string> = {},
): Promise<{ refreshToken: string; familyId: string }> {
  // Device flow: code → approve → exchange.
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
  const approve = await app.request("/api/auth/device/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ userCode: code.user_code }),
  });
  expect(approve.status).toBe(200);
  // Rewind polling throttle.
  await db
    .update(deviceCode)
    .set({ lastPolledAt: new Date(Date.now() - 10_000) })
    .where(eq(deviceCode.deviceCode, code.device_code));
  const tokenRes = await app.request("/api/auth/cli/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: code.device_code,
      client_id: "appstrate-cli",
    }),
  });
  expect(tokenRes.status).toBe(200);
  const body = (await tokenRes.json()) as { refresh_token: string };
  // Look up the persisted family for this token (helper for assertions).
  const { _hashRefreshTokenForTesting } = await import("../../../services/cli-tokens.ts");
  const [row] = await db
    .select()
    .from(cliRefreshToken)
    .where(eq(cliRefreshToken.tokenHash, _hashRefreshTokenForTesting(body.refresh_token)))
    .limit(1);
  if (!row) throw new Error("token row missing after exchange");
  return { refreshToken: body.refresh_token, familyId: row.familyId };
}

describe("GET /api/auth/cli/sessions (#251)", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    await createTestContext({ orgSlug: "clisess" });
    await ensureCliClient();
  });

  it("returns the caller's active sessions sorted by recency", async () => {
    const { cookie } = await signUp("alice@example.com", "Alice");

    // Two CLI logins → two families.
    const first = await loginCliFor(cookie, { "X-Appstrate-Device-Name": "laptop" });
    const second = await loginCliFor(cookie, { "X-Appstrate-Device-Name": "workstation" });

    // Force the second family to look "older" by writing an explicit
    // older lastUsedAt — the listing should put `laptop` after
    // `workstation` because laptop has no last_used (falls back to
    // createdAt which is later).
    await db
      .update(cliRefreshToken)
      .set({ lastUsedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(cliRefreshToken.familyId, second.familyId));

    const list = await app.request("/api/auth/cli/sessions", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: Array<{ familyId: string; deviceName: string | null; current: boolean }>;
    };
    expect(body.data.length).toBe(2);
    // laptop (no last_used → ranked by createdAt = newer) comes first.
    expect(body.data[0]!.deviceName).toBe("laptop");
    expect(body.data[1]!.deviceName).toBe("workstation");
    expect(body.data[0]!.current).toBe(false);
    expect(body.data[0]!.familyId).toBe(first.familyId);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const list = await app.request("/api/auth/cli/sessions", { method: "GET" });
    expect(list.status).toBe(401);
  });

  it("scopes the list to the caller — user A cannot see user B's sessions", async () => {
    const a = await signUp("a@example.com", "A");
    const b = await signUp("b@example.com", "B");
    await loginCliFor(a.cookie);
    await loginCliFor(b.cookie);

    const aList = await app.request("/api/auth/cli/sessions", {
      method: "GET",
      headers: { Cookie: a.cookie },
    });
    const aBody = (await aList.json()) as { data: Array<{ familyId: string }> };
    expect(aBody.data.length).toBe(1);

    const bList = await app.request("/api/auth/cli/sessions", {
      method: "GET",
      headers: { Cookie: b.cookie },
    });
    const bBody = (await bList.json()) as { data: Array<{ familyId: string }> };
    expect(bBody.data.length).toBe(1);
    expect(bBody.data[0]!.familyId).not.toBe(aBody.data[0]!.familyId);
  });

  it("excludes revoked and expired families from the listing", async () => {
    const { cookie, userId } = await signUp("c@example.com", "C");
    const active = await loginCliFor(cookie);
    const revoked = await loginCliFor(cookie);
    const expired = await loginCliFor(cookie);

    await db
      .update(cliRefreshToken)
      .set({ revokedAt: new Date(), revokedReason: "test" })
      .where(eq(cliRefreshToken.familyId, revoked.familyId));
    await db
      .update(cliRefreshToken)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(cliRefreshToken.familyId, expired.familyId));

    const res = await app.request("/api/auth/cli/sessions", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    const body = (await res.json()) as { data: Array<{ familyId: string }> };
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.familyId).toBe(active.familyId);
    // Sanity: the active row really is owned by the caller.
    const [row] = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.familyId, active.familyId))
      .limit(1);
    expect(row?.userId).toBe(userId);
  });
});

describe("POST /api/auth/cli/sessions/revoke (#251)", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    await createTestContext({ orgSlug: "clisessrevoke" });
    await ensureCliClient();
  });

  it("revokes a session owned by the caller and marks every row in the family", async () => {
    const { cookie } = await signUp("d@example.com", "D");
    const { familyId } = await loginCliFor(cookie);

    const res = await app.request("/api/auth/cli/sessions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ familyId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean };
    expect(body.revoked).toBe(true);

    // All rows in the family carry revoked_at + reason='user_revoked'.
    const rows = await db
      .select()
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.familyId, familyId));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.revokedAt).not.toBeNull();
      expect(r.revokedReason).toBe("user_revoked");
    }
  });

  it("returns revoked: false when the family belongs to a different user", async () => {
    const a = await signUp("e1@example.com", "E1");
    const b = await signUp("e2@example.com", "E2");
    const { familyId: bFamily } = await loginCliFor(b.cookie);

    const res = await app.request("/api/auth/cli/sessions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body: JSON.stringify({ familyId: bFamily }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean };
    expect(body.revoked).toBe(false);

    // B's family is still active.
    const [row] = await db
      .select()
      .from(cliRefreshToken)
      .where(and(eq(cliRefreshToken.familyId, bFamily)))
      .limit(1);
    expect(row?.revokedAt).toBeNull();
  });

  it("is idempotent — second revoke on an already-revoked family returns false", async () => {
    const { cookie } = await signUp("f@example.com", "F");
    const { familyId } = await loginCliFor(cookie);
    await app.request("/api/auth/cli/sessions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ familyId }),
    });
    const second = await app.request("/api/auth/cli/sessions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ familyId }),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { revoked: boolean };
    expect(body.revoked).toBe(false);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const res = await app.request("/api/auth/cli/sessions/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ familyId: "crf_anything" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/cli/sessions/revoke-all (#251)", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    await createTestContext({ orgSlug: "clisessall" });
    await ensureCliClient();
  });

  it("revokes every active family for the caller", async () => {
    const { cookie } = await signUp("g@example.com", "G");
    const f1 = await loginCliFor(cookie);
    const f2 = await loginCliFor(cookie);
    const f3 = await loginCliFor(cookie);

    const res = await app.request("/api/auth/cli/sessions/revoke-all", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedCount: number };
    expect(body.revokedCount).toBe(3);

    for (const f of [f1, f2, f3]) {
      const rows = await db
        .select()
        .from(cliRefreshToken)
        .where(eq(cliRefreshToken.familyId, f.familyId));
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.revokedAt).not.toBeNull();
        expect(r.revokedReason).toBe("user_revoked_all");
      }
    }
  });

  it("does not touch other users' sessions", async () => {
    const a = await signUp("h1@example.com", "H1");
    const b = await signUp("h2@example.com", "H2");
    await loginCliFor(a.cookie);
    const { familyId: bFamily } = await loginCliFor(b.cookie);

    const res = await app.request("/api/auth/cli/sessions/revoke-all", {
      method: "POST",
      headers: { Cookie: a.cookie },
    });
    expect(res.status).toBe(200);

    const [bRow] = await db
      .select()
      .from(cliRefreshToken)
      .where(and(eq(cliRefreshToken.familyId, bFamily)))
      .limit(1);
    expect(bRow?.revokedAt).toBeNull();
  });

  it("returns revokedCount: 0 when the caller has no active sessions", async () => {
    const { cookie } = await signUp("i@example.com", "I");
    const res = await app.request("/api/auth/cli/sessions/revoke-all", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedCount: number };
    expect(body.revokedCount).toBe(0);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const res = await app.request("/api/auth/cli/sessions/revoke-all", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
