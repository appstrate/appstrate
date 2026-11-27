// SPDX-License-Identifier: Apache-2.0

/**
 * An invalid `Authorization: Bearer …` never signs the browser out.
 *
 * Better Auth's `bearer()` plugin (oidc module) signs a dotless bearer itself
 * and substitutes it for the request's session cookie, so any string —
 * `Bearer undefined` from a script that read an unset variable — resolves to
 * no session. A request presenting a bearer is judged by it alone: 401, and
 * the auth pipeline writes no delete of the cookie the browser holds, which
 * was never the credential judged.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

function deletesSessionCookie(res: Response): boolean {
  return res.headers
    .getSetCookie()
    .some(
      (c) =>
        /(?:^|[\s;])(?:__Secure-)?better-auth\.session_token=/i.test(c) &&
        /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c),
    );
}

describe("auth pipeline — invalid bearer beside a valid session cookie", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bearerorg" });
  });

  // Dotless (signed by the plugin itself, so it replaced the cookie), dotted
  // with a wrong signature (the plugin ignored it, so the cookie answered 200),
  // and a JWT no strategy verifies (same fall-through).
  for (const authorization of [
    "Bearer undefined",
    "Bearer not-a-session-token",
    "Bearer forged.signature",
    "Bearer eyJhbGciOiJFUzI1NiJ9.e30.bm90LWEtc2ln",
  ]) {
    it(`answers 401 without clearing the session cookie (${authorization})`, async () => {
      const res = await app.request("/api/agents", {
        headers: authHeaders(ctx, { Authorization: authorization }),
      });
      expect(res.status).toBe(401);
      expect(deletesSessionCookie(res)).toBe(false);
      expect(res.headers.get("clear-site-data")).toBeNull();

      // The cookie still authenticates the next request.
      const after = await app.request("/api/agents", { headers: authHeaders(ctx) });
      expect(after.status).toBe(200);
    });
  }

  it("authenticates a valid session token presented as a bearer, and sets no cookie", async () => {
    // The raw `token.signature` value of the session cookie, without the cookie.
    const token = decodeURIComponent(ctx.cookie.slice(ctx.cookie.indexOf("=") + 1));
    const { Cookie: _cookie, ...headers } = authHeaders(ctx, { Authorization: `Bearer ${token}` });
    const res = await app.request("/api/agents", { headers });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("still buries a stale cookie when no bearer is presented", async () => {
    const res = await app.request("/api/agents", {
      headers: authHeaders(ctx, { Cookie: "better-auth.session_token=stale-value-no-session-row" }),
    });
    expect(res.status).toBe(401);
    expect(deletesSessionCookie(res)).toBe(true);
  });
});
