// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth's `session_data` cookie cache, measured end to end against THIS
 * repo's Better Auth version and plugin set.
 *
 * Why measured rather than reasoned about: the cache was hardcoded off to work
 * around upstream issue #7607 (an expired `session_data` reportedly failing to
 * regenerate from a still-valid `session_token`, logging users out). That issue
 * is now closed "not planned" — nobody shipped a fix, so its closure proves
 * nothing either way. The only trustworthy answer is what the installed version
 * actually does, which is what this file records.
 *
 * Every test drives the REAL sign-in endpoint and carries the WHOLE cookie jar
 * (`session_token` + `session_data`). The fast-path helper in `helpers/auth.ts`
 * crafts a `session_token` directly, which would bypass the cache entirely and
 * make every assertion here vacuous.
 *
 * The security half is the point, not a footnote: with the cache on, the DB read
 * that would notice a revocation is the read being skipped. The revocation-delay
 * tests below assert the size of that window rather than pretending it is zero.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { _resetCacheForTesting } from "@appstrate/env";
import { _rebuildAuthForTesting, getAuth } from "@appstrate/db/auth";
import { session as sessionTable } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser } from "../../helpers/auth.ts";

const app = getTestApp();

/** Short enough to expire inside a test, long enough not to race the request. */
const CACHE_TTL_SECONDS = 1;
const PAST_TTL_MS = CACHE_TTL_SECONDS * 1000 + 250;

const PASSWORD = "TestPassword123!";

/**
 * Run `fn` with the cookie cache configured to `seconds` (0 = disabled),
 * rebuilding the Better Auth singleton around it — the same env-then-rebuild
 * mechanism `auth-social-provider-config.test.ts` uses.
 */
async function withCookieCache(seconds: number, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.AUTH_SESSION_COOKIE_CACHE_SECONDS;
  process.env.AUTH_SESSION_COOKIE_CACHE_SECONDS = String(seconds);
  _resetCacheForTesting();
  _rebuildAuthForTesting();
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.AUTH_SESSION_COOKIE_CACHE_SECONDS;
    else process.env.AUTH_SESSION_COOKIE_CACHE_SECONDS = prev;
    _resetCacheForTesting();
    _rebuildAuthForTesting();
  }
}

/** Sign in for real and return the FULL cookie jar the browser would hold. */
async function signIn(email: string): Promise<{ jar: string; cookies: string[] }> {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const cookies = res.headers.getSetCookie();
  const jar = cookies
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
  return { jar, cookies };
}

/** The probe: authenticated, scope-independent, no org header required. */
async function getProfile(jar: string): Promise<Response> {
  return app.request("/api/profile", { headers: { Cookie: jar } });
}

async function seedSignedInUser(): Promise<{ userId: string; email: string; jar: string }> {
  const user = await createTestUser();
  const { jar } = await signIn(user.email);
  return { userId: user.id, email: user.email, jar };
}

afterAll(() => {
  // Belt and braces: leave the shared singleton on the repo default even if a
  // test threw between the env set and the finally block.
  delete process.env.AUTH_SESSION_COOKIE_CACHE_SECONDS;
  _resetCacheForTesting();
  _rebuildAuthForTesting();
});

describe("session cookie cache — the flag itself", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("issues NO session_data cookie when disabled (the repo default)", async () => {
    await withCookieCache(0, async () => {
      const user = await createTestUser();
      const { cookies } = await signIn(user.email);
      expect(cookies.some((c) => c.startsWith("better-auth.session_token="))).toBe(true);
      expect(cookies.some((c) => c.startsWith("better-auth.session_data="))).toBe(false);
    });
  });

  // Without this, every assertion below could pass against a cache that never
  // engaged.
  it("issues a session_data cookie when enabled", async () => {
    await withCookieCache(CACHE_TTL_SECONDS, async () => {
      const user = await createTestUser();
      const { cookies } = await signIn(user.email);
      const cached = cookies.find((c) => c.startsWith("better-auth.session_data="));
      expect(cached).toBeDefined();
      expect(cached).toContain(`Max-Age=${CACHE_TTL_SECONDS}`);
    });
  });
});

describe("session cookie cache — normal session lifecycle", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("authenticates a request from the cached session", async () => {
    await withCookieCache(CACHE_TTL_SECONDS, async () => {
      const { userId, jar } = await seedSignedInUser();
      const res = await getProfile(jar);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { id: string }).id).toBe(userId);
    });
  });

  /**
   * THE #7607 SCENARIO. `session_data` has expired; `session_token` has not.
   * The reported bug logged the user out here. If this test ever fails, the
   * cache must go back to off — this is the assertion the whole file exists for.
   */
  it("still authenticates AFTER session_data expires, from the surviving session_token", async () => {
    await withCookieCache(CACHE_TTL_SECONDS, async () => {
      const { userId, jar } = await seedSignedInUser();
      expect((await getProfile(jar)).status).toBe(200);

      await Bun.sleep(PAST_TTL_MS);

      const res = await getProfile(jar);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { id: string }).id).toBe(userId);
    });
  });

  it("keeps the denormalized session realm through a cache round-trip", async () => {
    await withCookieCache(CACHE_TTL_SECONDS, async () => {
      const { jar } = await seedSignedInUser();
      const headers = new Headers({ Cookie: jar });
      // First read populates/uses the cache; second is the cache hit. The realm
      // is an `additionalFields` column the platform-realm guard reads on every
      // request — a cached payload that dropped it would fail the guard open.
      const first = await getAuth().api.getSession({ headers });
      const second = await getAuth().api.getSession({ headers });
      expect(first?.session.realm).toBe("platform");
      expect(second?.session.realm).toBe("platform");
    });
  });
});

describe("session cookie cache — revocation", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  /**
   * MEASURED, and not what one would assume: a REPLAYED pre-logout jar keeps
   * authenticating after sign-out, for as long as the cached copy lives.
   *
   * Sign-out clears both cookies in its response, so the user's own browser is
   * logged out at once — this is about a jar someone else captured. The
   * `session_data` cookie is a self-contained signed assertion, and sign-out
   * has no way to reach into a copy it does not hold, so "log out on the stolen
   * device" and "log out everywhere" stop being immediate. That is the
   * exposure the TTL bounds, and it is the reason the flag defaults to 0.
   */
  it("keeps accepting a REPLAYED pre-logout jar until the cache expires", async () => {
    await withCookieCache(CACHE_TTL_SECONDS, async () => {
      const { jar } = await seedSignedInUser();
      expect((await getProfile(jar)).status).toBe(200);

      const out = await app.request("/api/auth/sign-out", {
        method: "POST",
        headers: { Cookie: jar, "Content-Type": "application/json" },
      });
      expect(out.status).toBe(200);
      // The response DOES clear both cookies for the client that made it.
      const cleared = out.headers.getSetCookie();
      expect(cleared.some((c) => c.startsWith("better-auth.session_data="))).toBe(true);

      // But the captured jar still works, inside the window.
      expect((await getProfile(jar)).status).toBe(200);

      await Bun.sleep(PAST_TTL_MS);
      expect((await getProfile(jar)).status).toBe(401);
    });
  });

  it("rejects a signed-out jar immediately when the cache is off", async () => {
    await withCookieCache(0, async () => {
      const { jar } = await seedSignedInUser();
      expect((await getProfile(jar)).status).toBe(200);

      const out = await app.request("/api/auth/sign-out", {
        method: "POST",
        headers: { Cookie: jar, "Content-Type": "application/json" },
      });
      expect(out.status).toBe(200);

      expect((await getProfile(jar)).status).toBe(401);
    });
  });

  /**
   * The cost side of the trade, stated as a measurement rather than a hope: a
   * session revoked out-of-band (another device, an admin, a removed member)
   * keeps working until the cached copy expires.
   */
  it("keeps accepting an out-of-band revoked session until the cache expires", async () => {
    await withCookieCache(CACHE_TTL_SECONDS, async () => {
      const { userId, jar } = await seedSignedInUser();
      expect((await getProfile(jar)).status).toBe(200);

      // Revoke the way another device / an admin would: the row is gone.
      await db.delete(sessionTable).where(eq(sessionTable.userId, userId));

      // Inside the window the request is still served — this is the exposure.
      expect((await getProfile(jar)).status).toBe(200);

      // Past the window the DB read happens again and the session is gone.
      await Bun.sleep(PAST_TTL_MS);
      expect((await getProfile(jar)).status).toBe(401);
    });
  });

  it("revokes immediately when the cache is off (the default's whole point)", async () => {
    await withCookieCache(0, async () => {
      const { userId, jar } = await seedSignedInUser();
      expect((await getProfile(jar)).status).toBe(200);

      await db.delete(sessionTable).where(eq(sessionTable.userId, userId));

      expect((await getProfile(jar)).status).toBe(401);
    });
  });
});

describe("session cookie cache — freshness gate", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  /**
   * `freshAge` (24h) gates BA's sensitive endpoints. The gate reads
   * `session.createdAt`, so it must survive the cache regenerating the payload
   * — a cached session that came back looking freshly created would hand a
   * day-old stolen cookie the step-up-protected endpoints.
   */
  it("still reports a stale session as stale after the cache expires", async () => {
    await withCookieCache(CACHE_TTL_SECONDS, async () => {
      const { userId, jar } = await seedSignedInUser();

      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await db
        .update(sessionTable)
        .set({ createdAt: twoDaysAgo })
        .where(eq(sessionTable.userId, userId));

      // Wait out the cached copy so the next read comes from the DB row above.
      await Bun.sleep(PAST_TTL_MS);

      const session = await getAuth().api.getSession({ headers: new Headers({ Cookie: jar }) });
      expect(session).not.toBeNull();
      expect(session!.session.createdAt.getTime()).toBeCloseTo(twoDaysAgo.getTime(), -3);
      // The session is still VALID (7-day expiry) — just no longer fresh, which
      // is exactly what the sensitive-endpoint gate keys on.
      expect(Date.now() - session!.session.createdAt.getTime()).toBeGreaterThan(
        24 * 60 * 60 * 1000,
      );
    });
  });
});
