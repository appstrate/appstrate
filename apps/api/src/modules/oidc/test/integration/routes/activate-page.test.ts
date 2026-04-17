// SPDX-License-Identifier: Apache-2.0

/**
 * SSR integration for the `/activate` user-facing device-flow page.
 *
 * Covers the three primary branches of the GET handler — unauthenticated
 * redirect, entry form, consent panel — and the POST normalization.
 * Approve/deny POSTs are covered indirectly via `device-flow-realm.test.ts`
 * (which hits BA's `/device/approve` directly); here we only assert the
 * SSR surface + CSRF gate.
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

const app = getTestApp({ modules: [oidcModule] });

async function signUpPlatformUser(): Promise<string> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "activate-test@example.com",
      password: "Sup3rSecretPass!",
      name: "T",
    }),
  });
  expect(res.status).toBe(200);
  const match = (res.headers.get("set-cookie") ?? "").match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error("no session cookie");
  const body = (await res.json()) as { user: { id: string } };
  await db.update(userTable).set({ realm: "platform" }).where(eq(userTable.id, body.user.id));
  await db
    .update(sessionTable)
    .set({ realm: "platform" })
    .where(eq(sessionTable.userId, body.user.id));
  return `better-auth.session_token=${match[1]}`;
}

async function requestDeviceCode(): Promise<{ userCode: string }> {
  const res = await app.request("/api/auth/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "appstrate-cli",
      scope: "openid profile email offline_access",
    }).toString(),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user_code: string };
  return { userCode: body.user_code };
}

describe("GET /activate", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    await createTestContext({ orgSlug: "activatepage" });
    await ensureCliClient();
  });

  it("renders the entry form when no user_code and no session", async () => {
    const res = await app.request("/activate");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Lier votre appareil");
    expect(html).toContain('name="user_code"');
    expect(html).toContain('name="_csrf"');
  });

  it("redirects to /auth/login when user_code is present but user is not authenticated", async () => {
    const res = await app.request("/activate?user_code=ABCD-EFGH");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/auth/login")).toBe(true);
    expect(location).toContain("returnTo=");
    expect(decodeURIComponent(location)).toContain("/activate?user_code=ABCD-EFGH");
  });

  it("renders the consent panel for an authenticated user with a valid user_code", async () => {
    const cookie = await signUpPlatformUser();
    const { userCode } = await requestDeviceCode();

    const res = await app.request(`/activate?user_code=${userCode}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Appstrate CLI");
    expect(html).toContain("Autoriser");
    expect(html).toContain("Refuser");
    // Display code should include a dash separator for readability.
    expect(html).toContain(`${userCode.slice(0, 4)}-${userCode.slice(4)}`);
  });

  it("rejects a malformed user_code with the entry form + error", async () => {
    const cookie = await signUpPlatformUser();
    const res = await app.request("/activate?user_code=SHORT", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("invalide");
  });

  it("shows a friendly error for an unknown user_code", async () => {
    const cookie = await signUpPlatformUser();
    const res = await app.request("/activate?user_code=ZZZZZZZZ", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Code introuvable");
  });
});

describe("POST /activate", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    await createTestContext({ orgSlug: "activatepost" });
    await ensureCliClient();
  });

  it("normalizes a dashed user_code and redirects to the consent view", async () => {
    // Grab a CSRF token by first hitting GET /activate.
    const getRes = await app.request("/activate");
    const setCookie = getRes.headers.get("set-cookie") ?? "";
    const csrfMatch = (await getRes.text()).match(/name="_csrf" value="([^"]+)"/);
    expect(csrfMatch).toBeTruthy();
    const csrfToken = csrfMatch![1];

    const res = await app.request("/activate", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: setCookie,
      },
      body: new URLSearchParams({
        _csrf: csrfToken!,
        user_code: "abcd-efgh",
      }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("/activate?user_code=ABCDEFGH");
  });

  it("rejects the submission with 403 when the CSRF token is missing", async () => {
    const res = await app.request("/activate", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user_code: "ABCDEFGH" }).toString(),
    });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("session a expiré");
  });
});
