// SPDX-License-Identifier: Apache-2.0

/**
 * How a magic-link verify is refused with `?error=signup_disabled`.
 *
 * Two sources, two suites:
 *
 *   - A client with a closed signup policy and an address with no account:
 *     `oidcBeforeSignupGuard` refuses the creation, and Better Auth's verify
 *     turns that `APIError` into a redirect to its origin-checked
 *     `errorCallbackURL`. Driven end to end through Better Auth's own
 *     `/magic-link/verify` with a link issued by `/api/oauth/magic-link`.
 *     Better Auth skips its origin check under test (`isTest()`), so that
 *     check is not exercised here.
 *   - A link whose client is gone (deleted or disabled):
 *     `enforceMagicLinkSignupPolicy` redirects before Better Auth runs. A
 *     plugin `hooks.before` fires BEFORE the route's `use:` chain, so Better
 *     Auth's `originCheck` has not yet validated `errorCallbackURL` and the
 *     hook gates the target's origin itself. Driven directly with a
 *     synthesized hook context, since the redirect target is the contract.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { prefixedId } from "@appstrate/db/ids";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { _authHookSlotsForTesting } from "@appstrate/db/auth";
import { spaces, user as userTable } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { captureIssuedMagicLinks, createTestContext } from "../../../../../../test/helpers/auth.ts";
import { enableSmtpForSuite } from "../../../../../../test/helpers/smtp.ts";
import { enforceMagicLinkSignupPolicy } from "../../../auth/guards.ts";
import { createClient, deleteClient, _resetClientCache } from "../../../services/oauth-admin.ts";
import { persistMagicLinkClientBinding } from "../../../services/oauth-transaction-binding.ts";
import {
  upsertSmtpConfig,
  _clearSmtpCacheForTesting,
  _setSmtpSpy,
} from "../../../services/smtp.ts";
import oidcModule from "../../../index.ts";

describe("magic-link verify — a closed-signup client and a new address", () => {
  enableSmtpForSuite();
  const app = getTestApp({ modules: [oidcModule] });
  const magicLinks = captureIssuedMagicLinks();

  // The boot installs every module's `beforeSignup` (`lib/boot.ts`); the test
  // app does not, so the suite installs the OIDC one and restores the original.
  const signupSlot = _authHookSlotsForTesting.beforeSignup;
  let installedSignupHook: ReturnType<typeof signupSlot.get>;
  beforeAll(() => {
    installedSignupHook = signupSlot.swapForTesting((email, ctx) =>
      oidcModule.hooks!.beforeSignup!(email, ctx),
    );
  });

  beforeEach(async () => {
    await truncateAll();
    _resetClientCache();
    _clearSmtpCacheForTesting();
    _setSmtpSpy(() => {});
  });

  afterEach(() => {
    _setSmtpSpy(null);
  });

  afterAll(() => {
    signupSlot.swapForTesting(installedSignupHook);
    getTestApp();
  });

  /** Issue a link for `email` through the client's hosted magic-link page. */
  async function issueLink(email: string): Promise<string> {
    const ctx = await createTestContext({ orgSlug: `closed-${crypto.randomUUID().slice(0, 8)}` });
    const spaceId = prefixedId("spc");
    await db
      .insert(spaces)
      .values({ id: spaceId, orgId: ctx.orgId, name: "Closed", createdBy: ctx.user.id });
    const client = await createClient({
      level: "space",
      name: "Closed app",
      redirectUris: ["https://closed.example.com/oauth/callback"],
      referencedSpaceId: spaceId,
      allowSignup: false,
    });
    await upsertSmtpConfig(spaceId, {
      host: "__test_json__",
      port: 587,
      username: "u",
      pass: "p",
      fromAddress: `no-reply@${spaceId}.test`,
      fromName: "Closed",
    });
    const qs = `?client_id=${encodeURIComponent(client.clientId)}&state=s`;
    const page = await app.request(`/api/oauth/magic-link${qs}`);
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    await app.request(`/api/oauth/magic-link${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: `_csrf=${csrf}&email=${encodeURIComponent(email)}`,
    });
    return magicLinks.tokenFor(email);
  }

  const accountOf = async (email: string) =>
    db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, email));

  it("is refused with signup_disabled on the error callback and creates no account", async () => {
    const email = `new-${crypto.randomUUID()}@closed.test`;
    const token = await issueLink(email);

    const res = await app.request(
      `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=%2F`,
    );

    expect(res.status).toBe(302);
    expect(
      new URL(res.headers.get("location")!, "http://localhost").searchParams.get("error"),
    ).toBe("signup_disabled");
    expect(res.headers.getSetCookie().join(";")).not.toContain("session_token");
    expect(await accountOf(email)).toHaveLength(0);
  });
});

interface RedirectThrown {
  redirectTo: string;
}

// BA's `ctx.redirect()` returns a value that the caller `throw`s. We
// emulate that contract: our fake records the URL and throws a sentinel
// the test can assert on. If the hook ever stops throwing the redirect
// (e.g. someone changes it to `return`), the test must catch that —
// hence the explicit "did not throw" branch.
function makeCtx(opts: {
  baseURL: string;
  query: { token?: string; errorCallbackURL?: string; callbackURL?: string };
}) {
  return {
    request: new Request(`${opts.baseURL}/api/auth/magic-link/verify`),
    query: opts.query,
    context: { baseURL: opts.baseURL },
    redirect: (url: string): never => {
      const err: RedirectThrown = { redirectTo: url };
      throw err;
    },
  };
}

async function redirectOf(ctx: ReturnType<typeof makeCtx>): Promise<RedirectThrown | null> {
  try {
    await enforceMagicLinkSignupPolicy(ctx);
  } catch (err) {
    return err as RedirectThrown;
  }
  return null;
}

describe("enforceMagicLinkSignupPolicy — a link whose client is gone", () => {
  let goneClientId: string;
  let liveClientId: string;
  const baseURL = "http://localhost:3000";

  beforeEach(async () => {
    await truncateAll();
    _resetClientCache();
    const ctx = await createTestContext({ orgSlug: "redirgate" });
    const client = (allowSignup: boolean) =>
      createClient({
        level: "org",
        name: "Portal",
        redirectUris: ["http://localhost:3000/cb"],
        referencedOrgId: ctx.orgId,
        allowSignup,
      });
    goneClientId = (await client(true)).clientId;
    await deleteClient(goneClientId);
    liveClientId = (await client(false)).clientId;
  });

  it("rewrites an off-origin errorCallbackURL to a safe in-origin redirect", async () => {
    await persistMagicLinkClientBinding("magic_redir_off", goneClientId);
    const redirected = await redirectOf(
      makeCtx({
        baseURL,
        query: {
          token: "magic_redir_off",
          errorCallbackURL: "https://evil.example.com/exfil",
          callbackURL: `${baseURL}/cb`,
        },
      }),
    );

    // The hook MUST throw the redirect: returning would let the link sign in.
    expect(redirected).not.toBeNull();
    // A positive origin check, not just "not evil": a broken target
    // (about:blank, empty) must fail too.
    const target = new URL(redirected!.redirectTo);
    expect(target.hostname).not.toBe("evil.example.com");
    expect(target.origin).toBe(baseURL);
    // The code drives the login page's localized banner.
    expect(target.searchParams.get("error")).toBe("signup_disabled");
  });

  it("preserves an in-origin errorCallbackURL exactly as supplied", async () => {
    // The OIDC login page is the canonical recovery surface: the origin gate
    // must not fail closed on it.
    const safe = `${baseURL}/api/oauth/login?client_id=${encodeURIComponent(goneClientId)}`;
    await persistMagicLinkClientBinding("magic_redir_in", goneClientId);
    const redirected = await redirectOf(
      makeCtx({
        baseURL,
        query: { token: "magic_redir_in", errorCallbackURL: safe, callbackURL: `${baseURL}/cb` },
      }),
    );

    expect(redirected).not.toBeNull();
    const target = new URL(redirected!.redirectTo);
    expect(target.origin).toBe(baseURL);
    expect(target.pathname).toBe("/api/oauth/login");
    expect(target.searchParams.get("client_id")).toBe(goneClientId);
    expect(target.searchParams.get("error")).toBe("signup_disabled");
  });

  it("falls back to safe redirect on malformed errorCallbackURL (lone %)", async () => {
    // `decodeURIComponent("%ZZ")` throws `URIError`: caught, and answered with
    // the same in-origin redirect as the off-origin branch rather than a 500.
    await persistMagicLinkClientBinding("magic_redir_malformed", goneClientId);
    const redirected = await redirectOf(
      makeCtx({
        baseURL,
        query: {
          token: "magic_redir_malformed",
          errorCallbackURL: "%ZZ",
          callbackURL: `${baseURL}/cb`,
        },
      }),
    );

    expect(redirected).not.toBeNull();
    const target = new URL(redirected!.redirectTo);
    expect(target.origin).toBe(baseURL);
    expect(target.searchParams.get("error")).toBe("signup_disabled");
  });

  it("falls back to safe redirect on unparseable URL string", async () => {
    // `new URL("https://[", baseURL)` throws `TypeError`, a different class
    // from the `URIError` above: a catch narrowed to one would fail here.
    await persistMagicLinkClientBinding("magic_redir_unparseable", goneClientId);
    const redirected = await redirectOf(
      makeCtx({
        baseURL,
        query: {
          token: "magic_redir_unparseable",
          errorCallbackURL: "https://[",
          callbackURL: `${baseURL}/cb`,
        },
      }),
    );

    expect(redirected).not.toBeNull();
    const target = new URL(redirected!.redirectTo);
    expect(target.origin).toBe(baseURL);
    expect(target.searchParams.get("error")).toBe("signup_disabled");
  });

  it("passes through when the bound client resolves, whatever its signup policy", async () => {
    // A closed policy is the signup guard's to enforce, inside Better Auth.
    await persistMagicLinkClientBinding("magic_live", liveClientId);
    await expect(
      enforceMagicLinkSignupPolicy(
        makeCtx({ baseURL, query: { token: "magic_live", callbackURL: `${baseURL}/cb` } }),
      ),
    ).resolves.toBeUndefined();
  });

  it("passes through when the verify carries no client binding", async () => {
    // Outside an OIDC flow the hook is a no-op.
    await expect(
      enforceMagicLinkSignupPolicy(
        makeCtx({
          baseURL,
          query: {
            token: "magic_no_binding",
            errorCallbackURL: "https://evil.example.com/x",
            callbackURL: `${baseURL}/cb`,
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
