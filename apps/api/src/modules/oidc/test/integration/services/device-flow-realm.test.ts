// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for PF-3: realm/level enforcement on BA's
 * `/device/approve`.
 *
 * The `deviceAuthorization()` plugin mints BA sessions directly via its
 * internal adapter — without our `oidcGuardsPlugin` hook on
 * `/device/approve`, an end-user of `level="application"` OIDC client
 * could approve an `appstrate-cli` (instance-level) device code and obtain
 * a session attached to their identity. The request-time `requirePlatformRealm`
 * middleware would reject the resulting token on every downstream platform
 * route, but the right place to refuse the attempt is at approve time.
 *
 * This test exercises the specific pathway the production flow follows:
 * one user signed up with `realm="end_user:<applicationId>"` tries to approve a
 * device code issued for the instance-level CLI client. Expected: 403
 * `access_denied`; the device code row stays `pending`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { user as userTable } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestContext } from "../../../../../../test/helpers/auth.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import oidcModule from "../../../index.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { ensureCliClient } from "../../../services/ensure-cli-client.ts";
import { deviceCode } from "../../../schema.ts";

const app = getTestApp({ modules: [oidcModule] });

/** Create a user via BA and force its realm to the target audience. */
async function signUpUserWithRealm(
  email: string,
  realm: string,
): Promise<{ cookie: string; userId: string }> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Sup3rSecretPass!", name: "T" }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error(`no session cookie: ${setCookie}`);
  const cookie = `better-auth.session_token=${match[1]}`;
  const body = (await res.json()) as { user: { id: string } };
  // Update both the user.realm and session.realm (which is denormalized
  // from user.realm at session-create time). The test bypasses the OIDC
  // pending-client cookie pathway, so we need to poke the realm directly.
  await db.update(userTable).set({ realm }).where(eq(userTable.id, body.user.id));
  const { session } = await import("@appstrate/db/schema");
  await db.update(session).set({ realm }).where(eq(session.userId, body.user.id));
  return { cookie, userId: body.user.id };
}

async function requestDeviceCode(): Promise<{ userCode: string; deviceCode: string }> {
  // Better Auth's `better-call` router rejects `application/x-www-form-urlencoded`
  // with 415 despite RFC 8628 §3.2 specifying it — send JSON to match the
  // server reality (and the CLI client in `apps/cli/src/lib/device-flow.ts`).
  const res = await app.request("/api/auth/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "appstrate-cli",
      scope: "openid profile email offline_access",
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user_code: string; device_code: string };
  return { userCode: body.user_code, deviceCode: body.device_code };
}

describe("device-flow realm enforcement on /device/approve", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    await createTestContext({ orgSlug: "devflow" });
    await ensureCliClient();
  });

  it("rejects approval by an end-user realm (realm=end_user:<applicationId>, client level=instance)", async () => {
    const { cookie } = await signUpUserWithRealm("enduser@example.com", "end_user:app_some_id");
    const { userCode } = await requestDeviceCode();

    const approveRes = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ userCode }),
    });

    expect(approveRes.status).toBe(403);
    const body = (await approveRes.json()) as { error?: string };
    expect(body.error).toBe("access_denied");

    // The device code row stays in `pending` — realm guard refuses the
    // approve BEFORE BA's own handler flips the status.
    const [row] = await db
      .select({ status: deviceCode.status, userId: deviceCode.userId })
      .from(deviceCode)
      .where(eq(deviceCode.userCode, userCode.replace(/-/g, "").toUpperCase()))
      .limit(1);
    expect(row?.status).toBe("pending");
    expect(row?.userId).toBeNull();
  });

  it("accepts approval by a platform-realm user", async () => {
    const { cookie, userId } = await signUpUserWithRealm("platform@example.com", "platform");
    const { userCode } = await requestDeviceCode();

    const approveRes = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ userCode }),
    });

    expect(approveRes.status).toBe(200);
    const body = (await approveRes.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const [row] = await db
      .select({ status: deviceCode.status, userId: deviceCode.userId })
      .from(deviceCode)
      .where(eq(deviceCode.userCode, userCode.replace(/-/g, "").toUpperCase()))
      .limit(1);
    expect(row?.status).toBe("approved");
    expect(row?.userId).toBe(userId);
  });

  it("rejects approval when no session is attached", async () => {
    const { userCode } = await requestDeviceCode();

    const approveRes = await app.request("/api/auth/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode }),
    });

    expect(approveRes.status).toBe(401);
    const body = (await approveRes.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
  });
});
