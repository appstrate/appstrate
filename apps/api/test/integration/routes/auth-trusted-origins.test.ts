// SPDX-License-Identifier: Apache-2.0

// With TRUSTED_ORIGINS unset, the app's own origin (APP_URL) still signs up,
// signs in and signs out through Better Auth, and any other origin is refused.

import { describe, it, expect, beforeEach } from "bun:test";
import { getAuth } from "@appstrate/db/auth";
import { getEnv } from "@appstrate/env";
import { getTestApp } from "../../helpers/app.ts";
import { useAuthEnv } from "../../helpers/auth-env.ts";
import { truncateAll } from "../../helpers/db.ts";
import { flushRedis } from "../../helpers/redis.ts";

const app = getTestApp();

useAuthEnv({ TRUSTED_ORIGINS: undefined });

const FOREIGN_ORIGIN = "http://localhost:5173";
const PASSWORD = "TestPassword123!";

function post(path: string, origin: string, body: unknown, cookie?: string) {
  return app.request(`/api/auth${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function sessionCookie(res: Response): string {
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.includes("session_token="));
  if (!cookie) throw new Error("no session cookie set");
  return cookie;
}

describe("Better Auth origin check with TRUSTED_ORIGINS unset", () => {
  let appOrigin: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    appOrigin = getEnv().APP_URL;
    expect(getEnv().TRUSTED_ORIGINS).toEqual([]);
    // Better Auth skips its origin check when NODE_ENV=test; run the real one.
    (await getAuth().$context).skipOriginCheck = false;
  });

  it("signs up and signs in from APP_URL, refuses another origin", async () => {
    const email = "origin-check@example.com";
    const signUp = { email, password: PASSWORD, name: "Origin" };

    expect((await post("/sign-up/email", FOREIGN_ORIGIN, signUp)).status).toBe(403);
    expect((await post("/sign-up/email", appOrigin, signUp)).status).toBe(200);

    const signIn = { email, password: PASSWORD };
    expect((await post("/sign-in/email", FOREIGN_ORIGIN, signIn)).status).toBe(403);
    const res = await post("/sign-in/email", appOrigin, signIn);
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeTruthy();
  });

  it("refuses a cookie-bearing request from another origin", async () => {
    const email = "origin-cookie@example.com";
    const res = await post("/sign-up/email", appOrigin, { email, password: PASSWORD, name: "C" });
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);

    expect((await post("/sign-out", FOREIGN_ORIGIN, {}, cookie)).status).toBe(403);
    expect((await post("/sign-out", appOrigin, {}, cookie)).status).toBe(200);
  });
});
