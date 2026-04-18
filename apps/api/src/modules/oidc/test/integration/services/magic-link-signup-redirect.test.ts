// SPDX-License-Identifier: Apache-2.0

/**
 * Open-redirect regression on `enforceMagicLinkSignupPolicy`.
 *
 * The hook short-circuits a magic-link verify with a `?error=signup_disabled`
 * redirect when the pending OAuth client has `allowSignup=false` AND the
 * verify would create a brand-new user. The redirect target is built from
 * the request's `errorCallbackURL` (or `callbackURL` fallback) — both are
 * attacker-controlled query params at this stage of the request because:
 *
 *   - Better Auth's `originCheck` middleware (registered via `use:` on
 *     `/magic-link/verify` — see `node_modules/better-auth/dist/plugins/
 *     magic-link/index.mjs:87-95`) validates these URLs against
 *     `trustedOrigins`, BUT
 *   - plugin `hooks.before` fire BEFORE the route's `use:` chain (see
 *     `node_modules/better-auth/dist/api/to-auth-endpoints.mjs:74` →
 *     `runBeforeHooks` precedes `endpoint(...)` which executes `use:`).
 *
 * Without an explicit same-origin gate in `enforceMagicLinkSignupPolicy`,
 * an attacker who can place a `oidc_pending_client` cookie on the victim's
 * browser (e.g. by linking the victim through the OAuth login entry page
 * for a closed-signup client) and trick the victim into clicking a
 * magic-link URL with `errorCallbackURL=https://evil.example.com/x`
 * receives an authenticated open-redirect into `https://evil.example.com/x
 * ?error=signup_disabled`. Useful for branded "your sign-in failed,
 * please re-enter your password" phishing.
 *
 * Test approach: the `magicLink()` plugin only mounts `/magic-link/verify`
 * when SMTP is configured, and the test preload deliberately strips SMTP
 * env vars. We therefore exercise `enforceMagicLinkSignupPolicy` directly
 * with a synthesized BA hook context. This is the same pattern
 * `signup-guard.test.ts` uses for `oidcBeforeSignupGuard` — the alternative
 * (enabling SMTP in the test env and running BA's full magic-link plugin)
 * would buy negligible additional coverage at the cost of substantial
 * test-infra surface and would be torn down the next time SMTP gating
 * changes.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { db } from "@appstrate/db/client";
import { getEnv } from "@appstrate/env";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestContext } from "../../../../../../test/helpers/auth.ts";
import { enforceMagicLinkSignupPolicy } from "../../../auth/guards.ts";
import { createClient, _resetClientCache } from "../../../services/oauth-admin.ts";

// Mirrors `services/pending-client-cookie.ts` — kept inline so the test
// is agnostic to internal refactors of the cookie helper.
function pendingClientCookie(clientId: string): string {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const payload = `${clientId}.${exp}`;
  const sig = createHmac("sha256", getEnv().BETTER_AUTH_SECRET)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `oidc_pending_client=${payload}.${sig}`;
}

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
  cookie: string;
  query: { token?: string; errorCallbackURL?: string; callbackURL?: string };
  email: string;
  emailExists: boolean;
}): {
  request: Request;
  query: { token?: string; errorCallbackURL?: string; callbackURL?: string };
  context: {
    baseURL: string;
    internalAdapter: {
      findVerificationValue: (k: string) => Promise<{ value: string; expiresAt: Date } | null>;
      findUserByEmail: (e: string) => Promise<{ user: unknown } | null>;
    };
  };
  redirect: (url: string) => never;
} {
  return {
    request: new Request(`${opts.baseURL}/api/auth/magic-link/verify`, {
      headers: { cookie: opts.cookie },
    }),
    query: opts.query,
    context: {
      baseURL: opts.baseURL,
      internalAdapter: {
        // The hook only inspects `value` (parsed for `email`) and short-
        // circuits on null. Returning a populated row exercises the
        // redirect path; returning null exercises the pass-through.
        findVerificationValue: async () => ({
          value: JSON.stringify({ email: opts.email }),
          expiresAt: new Date(Date.now() + 60_000),
        }),
        findUserByEmail: async () => (opts.emailExists ? { user: { id: "x" } } : null),
      },
    },
    redirect: (url: string): never => {
      const err: RedirectThrown = { redirectTo: url };
      throw err;
    },
  };
}

describe("enforceMagicLinkSignupPolicy — redirect target gating", () => {
  let closedOrgClientId: string;
  const baseURL = "http://localhost:3000";

  beforeEach(async () => {
    await truncateAll();
    _resetClientCache();
    const ctx = await createTestContext({ orgSlug: "redirgate" });

    // A client with closed signup so the hook fires its redirect path
    // (rather than falling through and letting BA proceed to createUser).
    const closed = await createClient({
      level: "org",
      name: "Closed Portal",
      redirectUris: ["http://localhost:3000/cb"],
      referencedOrgId: ctx.orgId,
      allowSignup: false,
    });
    closedOrgClientId = closed.clientId;
  });

  it("rewrites an off-origin errorCallbackURL to a safe in-origin redirect", async () => {
    const evil = "https://evil.example.com/exfil";
    const ctx = makeCtx({
      baseURL,
      cookie: pendingClientCookie(closedOrgClientId),
      query: { token: "magic_redir_off", errorCallbackURL: evil, callbackURL: `${baseURL}/cb` },
      email: `fresh-${Date.now()}@example.com`,
      emailExists: false,
    });

    let redirected: RedirectThrown | null = null;
    try {
      await enforceMagicLinkSignupPolicy(ctx);
    } catch (err) {
      redirected = err as RedirectThrown;
    }

    // The hook MUST throw the redirect — if it returned silently the
    // closed-signup gate has been bypassed, defeating the whole point
    // of the hook (a separate but equally damaging regression).
    expect(redirected).not.toBeNull();
    expect(redirected!.redirectTo).toBeTruthy();

    // CRITICAL: the redirect MUST NOT point at evil.example.com. If
    // this fails, the open-redirect is back. We assert positively on
    // the safe origin too — checking the absence of evil alone would
    // miss a "redirect to about:blank" or similarly broken state.
    const target = new URL(redirected!.redirectTo);
    expect(target.hostname).not.toBe("evil.example.com");
    expect(target.origin).toBe(baseURL);

    // The error code must still be carried so the login page can
    // render the localized banner — losing it would silently break
    // the closed-signup UX even though the security fix lands.
    expect(target.searchParams.get("error")).toBe("signup_disabled");
  });

  it("preserves an in-origin errorCallbackURL exactly as supplied", async () => {
    // Negative regression: the same-origin gate must NOT reject legit
    // same-origin URLs. The OIDC login page lives at
    // /api/oauth/login?client_id=... and is the canonical recovery
    // surface — fail-closing on this would break every closed-signup
    // OAuth client in production.
    const safe = `${baseURL}/api/oauth/login?client_id=${encodeURIComponent(closedOrgClientId)}`;
    const ctx = makeCtx({
      baseURL,
      cookie: pendingClientCookie(closedOrgClientId),
      query: { token: "magic_redir_in", errorCallbackURL: safe, callbackURL: `${baseURL}/cb` },
      email: `inorigin-${Date.now()}@example.com`,
      emailExists: false,
    });

    let redirected: RedirectThrown | null = null;
    try {
      await enforceMagicLinkSignupPolicy(ctx);
    } catch (err) {
      redirected = err as RedirectThrown;
    }

    expect(redirected).not.toBeNull();
    const target = new URL(redirected!.redirectTo);
    expect(target.origin).toBe(baseURL);
    expect(target.pathname).toBe("/api/oauth/login");
    expect(target.searchParams.get("client_id")).toBe(closedOrgClientId);
    expect(target.searchParams.get("error")).toBe("signup_disabled");
  });

  it("pass-through when no pending-client cookie is present", async () => {
    // Sanity: outside an OIDC flow, the hook is a no-op. If this ever
    // starts redirecting, the gate has accidentally widened to apply
    // to every magic-link signup, breaking the platform sign-up UX.
    const ctx = makeCtx({
      baseURL,
      cookie: "",
      query: {
        token: "magic_no_cookie",
        errorCallbackURL: "https://evil.example.com/x",
        callbackURL: `${baseURL}/cb`,
      },
      email: `fresh2-${Date.now()}@example.com`,
      emailExists: false,
    });
    // Use db here just to silence "unused import" warnings if we ever
    // need raw queries — left intentionally unused, inspecting db
    // state is not part of this contract.
    void db;
    await expect(enforceMagicLinkSignupPolicy(ctx)).resolves.toBeUndefined();
  });
});
