// SPDX-License-Identifier: Apache-2.0

/**
 * Stale Better Auth cookie cleanup.
 *
 * After a redeploy that rotates `BETTER_AUTH_SECRET` or wipes `session` rows,
 * the browser keeps sending the now-invalid BA cookie on every request. The
 * server used to answer 401 and leave the cookie in place — so the SPA
 * bounced between `/login` and `/auth/callback` forever with no surfaceable
 * error.
 *
 * The auth pipeline now answers 401 with two complementary mechanisms:
 *   1. `Set-Cookie: …; Max-Age=0` for every BA cookie name (works when the
 *      Domain/Path of the original cookie still match the current config).
 *   2. `Clear-Site-Data: "cookies"` as a backstop for when a previous
 *      deployment issued the cookie under a different `COOKIE_DOMAIN` —
 *      RFC 6265 silently rejects the targeted delete in that case, but
 *      `Clear-Site-Data` purges the origin's cookie jar without needing
 *      Domain/Path to match. See `lib/auth-cookies.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";

const app = getTestApp();

/**
 * Pull every `Set-Cookie` value off a Response, regardless of casing or the
 * runtime's choice between `headers.getSetCookie()` and a single coalesced
 * header. The route under test is allowed to emit multiple `Set-Cookie`
 * values (one per BA cookie name), so the assertion has to handle the
 * multi-valued case.
 */
function getSetCookies(res: Response): string[] {
  const headers = res.headers;
  // `Headers.getSetCookie()` is the standard way to read multiple
  // `Set-Cookie` values when the runtime supports it (Bun ≥ 1.0).
  const native = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (native && native.length > 0) return native;
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

describe("auth pipeline — stale cookie cleanup", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("returns 401 with Set-Cookie clearing the BA session cookies when the session is stale", async () => {
    // Forge a request that LOOKS like it has a BA session cookie but whose
    // session_token is bogus — same shape a stale cookie would have after a
    // redeploy: the cookie name + signed-cookie envelope are well-formed,
    // but the value does not resolve to any session row.
    const res = await app.request("/api/agents", {
      headers: {
        Cookie:
          "better-auth.session_token=stale-value-no-session-row; better-auth.session_data=stale-cache",
        "X-Org-Id": "00000000-0000-0000-0000-000000000000",
      },
    });

    expect(res.status).toBe(401);

    const setCookies = getSetCookies(res);
    expect(setCookies.length).toBeGreaterThan(0);

    // At least one Set-Cookie must target the session_token cookie name and
    // expire it (Max-Age=0 OR an Expires in the past). Both forms are
    // accepted because some serializers prefer one over the other.
    const sessionTokenClear = setCookies.find((c) =>
      /(?:^|[\s;])(?:__Secure-)?better-auth\.session_token=/i.test(c),
    );
    expect(sessionTokenClear).toBeDefined();
    expect(sessionTokenClear).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('emits Clear-Site-Data: "cookies" as backstop when the session is stale', async () => {
    // Backstop for the case where the cookie was issued under a previous
    // `COOKIE_DOMAIN` and the targeted Set-Cookie delete cannot match.
    const res = await app.request("/api/agents", {
      headers: {
        Cookie:
          "better-auth.session_token=stale-value-no-session-row; better-auth.session_data=stale-cache",
        "X-Org-Id": "00000000-0000-0000-0000-000000000000",
      },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("clear-site-data")).toBe('"cookies"');
  });

  it("does not emit a session_token clearing cookie on routes that succeed without auth", async () => {
    // `/health` is a public route mounted before the auth middleware.
    // The pipeline must not gratuitously clear cookies on every request —
    // only on the 401-on-stale-cookie path.
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const setCookies = getSetCookies(res);
    const sessionTokenClear = setCookies.find(
      (c) =>
        /(?:^|[\s;])(?:__Secure-)?better-auth\.session_token=/i.test(c) &&
        /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c),
    );
    expect(sessionTokenClear).toBeUndefined();
    // And no Clear-Site-Data on a healthy public response.
    expect(res.headers.get("clear-site-data")).toBeNull();
  });
});
