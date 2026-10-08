// SPDX-License-Identifier: Apache-2.0

/**
 * Sliding session refresh reaches the browser.
 *
 * Once a session row is older than `updateAge` (24h), Better Auth's
 * `getSession` extends `expiresAt` in the DB AND re-issues the session cookie
 * with a fresh Max-Age. Server-side session reads must forward that
 * `Set-Cookie`: dropping it extends the row but not the cookie, and the user
 * is logged out `expiresIn` (7 days) after sign-in however active they are.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppstrateModule } from "@appstrate/core/module";
import { session as sessionTable } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  ageSessionPastUpdateAge,
  authHeaders,
  createTestContext,
  createTestUser,
  SESSION_TTL_MS,
} from "../../helpers/auth.ts";

const app = getTestApp();

/** A route behind the auth pipeline that answers a hand-built `Response` setting its own cookie. */
const PROBE_PATH = "/api/session-refresh-probe";
const PROBE_COOKIE = "probe=1; Path=/";
const probeModule: AppstrateModule = {
  manifest: { id: "session-refresh-probe", name: "Session Refresh Probe", version: "1.0.0" },
  async init() {},
  createRouter() {
    return new Hono().get(
      PROBE_PATH,
      () => new Response("ok", { headers: { "Set-Cookie": PROBE_COOKIE } }),
    );
  },
};
const probeApp = getTestApp({ modules: [probeModule] });

const MAX_AGE = `Max-Age=${SESSION_TTL_MS / 1000}`;

function sessionTokenCookies(res: Response): string[] {
  return res.headers.getSetCookie().filter((c) => c.startsWith("better-auth.session_token="));
}

async function sessionExpiresAt(userId: string): Promise<Date> {
  const [row] = await db
    .select({ expiresAt: sessionTable.expiresAt })
    .from(sessionTable)
    .where(eq(sessionTable.userId, userId));
  return row!.expiresAt;
}

describe("session refresh — Set-Cookie forwarding", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("re-issues the session cookie when a platform route refreshes the row", async () => {
    const user = await createTestUser();
    await ageSessionPastUpdateAge(user.id);
    const before = await sessionExpiresAt(user.id);

    const res = await app.request("/api/profile", { headers: { Cookie: user.cookie } });

    expect(res.status).toBe(200);
    const cookies = sessionTokenCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain(MAX_AGE);
    const after = await sessionExpiresAt(user.id);
    expect(after.getTime()).toBeGreaterThan(before.getTime() + 60 * 60 * 1000);
  });

  it("emits no session cookie while the row is younger than updateAge", async () => {
    const user = await createTestUser();

    const res = await app.request("/api/profile", { headers: { Cookie: user.cookie } });

    expect(res.status).toBe(200);
    expect(sessionTokenCookies(res)).toEqual([]);
  });

  it("re-issues the session cookie on a hand-built Response, keeping the route's own cookie", async () => {
    const ctx = await createTestContext({ orgSlug: "refresh" });
    await ageSessionPastUpdateAge(ctx.user.id);

    const res = await probeApp.request(PROBE_PATH, { headers: authHeaders(ctx) });

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toContain(PROBE_COOKIE);
    const cookies = sessionTokenCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain(MAX_AGE);
  });

  it("re-issues the session cookie when a route behind the pipeline throws", async () => {
    const user = await createTestUser();
    await ageSessionPastUpdateAge(user.id);

    // No `X-Org-Id`: org context throws downstream of the auth pipeline.
    const res = await app.request("/api/agents", { headers: { Cookie: user.cookie } });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const cookies = sessionTokenCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain(MAX_AGE);
  });

  it("forwards the refreshed cookie on an error response from a pipeline-exempt route", async () => {
    const user = await createTestUser();
    await ageSessionPastUpdateAge(user.id);

    // Valid session, no `orgId`: the realtime route reads the session, then 401s.
    const res = await app.request("/api/realtime/runs/run_x", {
      headers: { Cookie: user.cookie },
    });

    expect(res.status).toBe(401);
    const cookies = sessionTokenCookies(res);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain(MAX_AGE);
  });
});
