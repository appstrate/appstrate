// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `oidc_login_notice` one-shot signed cookie — the UX
 * banner + anti-loop marker for the login-link-expiry restart flow.
 *
 * The cookie helpers need a Hono `Context`, so we drive them through a minimal
 * in-process Hono app (`app.request()`, no port/DB) and inspect the emitted
 * `Set-Cookie` headers. Tamper / expiry / garbage cases build the raw cookie
 * value from the same signing building blocks (`signAuthHmac`) the service
 * uses, then send it back on the `Cookie` header.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import {
  issueLoginNoticeCookie,
  readAndClearLoginNoticeCookie,
  buildSignedLoginNoticeValue,
  type LoginNotice,
} from "../../services/login-notice-cookie.ts";
import { signAuthHmac } from "../../../../lib/auth-secrets.ts";
import type { AppEnv } from "../../../../types/index.ts";

const COOKIE_NAME = "oidc_login_notice";

function makeApp() {
  const app = new Hono<AppEnv>();
  app.post("/issue", async (c) => {
    const body = (await c.req.json()) as { email?: string };
    const notice: LoginNotice =
      body.email !== undefined
        ? { code: "login_link_expired", email: body.email }
        : { code: "login_link_expired" };
    issueLoginNoticeCookie(c, notice);
    return c.text("ok");
  });
  app.get("/read", (c) => {
    const notice = readAndClearLoginNoticeCookie(c);
    return c.json({ notice });
  });
  return app;
}

/** Extract the `name=value` first segment from a `Set-Cookie` header. */
function cookiePairFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";")[0]!;
}

/** Issue a notice, returning the `Cookie`-header pair the browser would send back. */
async function issueAndCapture(app: Hono<AppEnv>, body: { email?: string }): Promise<string> {
  const res = await app.request("/issue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return cookiePairFrom(res);
}

/** Read the notice back given a raw cookie value; returns the parsed notice + the read Response. */
async function readWithCookie(
  app: Hono<AppEnv>,
  cookieHeader: string,
): Promise<{ notice: LoginNotice | null; res: Response }> {
  const res = await app.request("/read", { headers: { cookie: cookieHeader } });
  const body = (await res.json()) as { notice: LoginNotice | null };
  return { notice: body.notice, res };
}

describe("login-notice-cookie", () => {
  it("issue → read round-trips the payload without email", async () => {
    const app = makeApp();
    const pair = await issueAndCapture(app, {});
    const { notice } = await readWithCookie(app, pair);
    expect(notice).toEqual({ code: "login_link_expired" });
  });

  it("issue → read round-trips the payload with email", async () => {
    const app = makeApp();
    const pair = await issueAndCapture(app, { email: "user@example.com" });
    const { notice } = await readWithCookie(app, pair);
    expect(notice).toEqual({ code: "login_link_expired", email: "user@example.com" });
  });

  it("preserves emails with dots, plus signs, and unicode across the round-trip", async () => {
    const app = makeApp();
    const emails = ["first.last+tag@sub.example.co.uk", "üñïçødé@exämple.com", "a.b.c+d.e@x.y.z"];
    for (const email of emails) {
      const pair = await issueAndCapture(app, { email });
      const { notice } = await readWithCookie(app, pair);
      expect(notice).toEqual({ code: "login_link_expired", email });
    }
  });

  it("returns null for a tampered signature", async () => {
    const app = makeApp();
    const raw = buildSignedLoginNoticeValue({ code: "login_link_expired", email: "a@b.com" });
    // Flip the final char of the signature.
    const last = raw.at(-1) === "A" ? "B" : "A";
    const tampered = raw.slice(0, -1) + last;
    const { notice } = await readWithCookie(app, `${COOKIE_NAME}=${tampered}`);
    expect(notice).toBeNull();
  });

  it("returns null for an expired exp (verified sig, past timestamp)", async () => {
    const app = makeApp();
    const encoded = Buffer.from(JSON.stringify({ code: "login_link_expired" }), "utf8").toString(
      "base64url",
    );
    const exp = Math.floor(Date.now() / 1000) - 5;
    const sig = signAuthHmac(`${encoded}.${exp}`);
    const raw = `${encoded}.${exp}.${sig}`;
    const { notice } = await readWithCookie(app, `${COOKIE_NAME}=${raw}`);
    expect(notice).toBeNull();
  });

  it("returns null for garbage / wrong part count", async () => {
    const app = makeApp();
    for (const raw of ["garbage", "a.b", "a.b.c.d", ""]) {
      const { notice } = await readWithCookie(app, `${COOKIE_NAME}=${raw}`);
      expect(notice).toBeNull();
    }
  });

  it("returns null when the payload decodes but has the wrong shape", async () => {
    const app = makeApp();
    // Valid sig + exp, but the JSON payload uses an unknown code.
    const encoded = Buffer.from(JSON.stringify({ code: "something_else" }), "utf8").toString(
      "base64url",
    );
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = signAuthHmac(`${encoded}.${exp}`);
    const { notice } = await readWithCookie(app, `${COOKIE_NAME}=${encoded}.${exp}.${sig}`);
    expect(notice).toBeNull();
  });

  it("clears the cookie on read even when the value is invalid", async () => {
    const app = makeApp();
    const { notice, res } = await readWithCookie(app, `${COOKIE_NAME}=garbage`);
    expect(notice).toBeNull();
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toContain("Max-Age=0");
  });

  it("clears the cookie on read of a valid value (one-shot)", async () => {
    const app = makeApp();
    const pair = await issueAndCapture(app, { email: "one@shot.com" });
    const { notice, res } = await readWithCookie(app, pair);
    expect(notice).toEqual({ code: "login_link_expired", email: "one@shot.com" });
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`${COOKIE_NAME}=`);
    expect(setCookie).toContain("Max-Age=0");
  });

  it("returns null when no cookie is present", async () => {
    const app = makeApp();
    const res = await app.request("/read");
    const body = (await res.json()) as { notice: LoginNotice | null };
    expect(body.notice).toBeNull();
  });
});
