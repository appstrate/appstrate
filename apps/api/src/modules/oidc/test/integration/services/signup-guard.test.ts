// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the OIDC `beforeSignup` guard + pending-client
 * cookie contract.
 *
 * The guard is exercised directly (rather than via a full HTTP round-trip
 * through Better Auth) so we can assert precisely on its behavior for each
 * cookie / client combination. A separate e2e test covers the full social
 * sign-in chain.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { APIError } from "better-auth/api";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizationMembers } from "@appstrate/db/schema";
import { createClient, _resetClientCache } from "../../../services/oauth-admin.ts";
import { oidcBeforeSignupGuard, oidcAfterSignupHandler } from "../../../auth/signup-guard.ts";

// The cookie helpers we're testing — issue a fake Headers for the guard.
// We rebuild the signed cookie out-of-band so the test is agnostic to
// how the entry pages encode it; the cookie format lives in
// `services/pending-client-cookie.ts`.
async function signedCookieHeader(clientId: string): Promise<Headers> {
  const { createHmac } = await import("node:crypto");
  const { getEnv } = await import("@appstrate/env");
  const exp = Math.floor(Date.now() / 1000) + 600;
  const payload = `${clientId}.${exp}`;
  const sig = createHmac("sha256", getEnv().BETTER_AUTH_SECRET)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const cookieValue = `${payload}.${sig}`;
  return new Headers({ cookie: `oidc_pending_client=${cookieValue}` });
}

function expiredCookieHeader(clientId: string, sig = "tampered"): Headers {
  const exp = Math.floor(Date.now() / 1000) - 60; // past
  return new Headers({ cookie: `oidc_pending_client=${clientId}.${exp}.${sig}` });
}

describe("oidcBeforeSignupGuard + pending-client cookie", () => {
  let ctx: TestContext;
  let closedOrgClientId: string;
  let openOrgClientId: string;
  let appClientId: string;

  beforeEach(async () => {
    await truncateAll();
    _resetClientCache();
    ctx = await createTestContext({ orgSlug: "signupguard" });

    const closed = await createClient({
      level: "org",
      name: "Closed Portal",
      redirectUris: ["https://closed.example.com/cb"],
      referencedOrgId: ctx.orgId,
      allowSignup: false,
    });
    closedOrgClientId = closed.clientId;

    const open = await createClient({
      level: "org",
      name: "Open Portal",
      redirectUris: ["https://open.example.com/cb"],
      referencedOrgId: ctx.orgId,
      allowSignup: true,
      signupRole: "member",
    });
    openOrgClientId = open.clientId;

    const appClient = await createClient({
      level: "application",
      name: "App Client",
      redirectUris: ["https://app.example.com/cb"],
      referencedApplicationId: ctx.defaultAppId,
    });
    appClientId = appClient.clientId;
  });

  it("pass-through when no cookie is present (signup outside OIDC flow)", async () => {
    await expect(
      oidcBeforeSignupGuard({
        user: { email: "outside@example.com" },
        headers: null,
      }),
    ).resolves.toBeUndefined();
  });

  it("pass-through when cookie signature is invalid", async () => {
    await expect(
      oidcBeforeSignupGuard({
        user: { email: "bad@example.com" },
        headers: expiredCookieHeader(closedOrgClientId, "notasignature"),
      }),
    ).resolves.toBeUndefined();
  });

  it("pass-through when cookie is expired", async () => {
    // Build a cookie with a correct HMAC over a past `exp` — the guard
    // still rejects it because the expiry check runs after signature
    // verification.
    const { createHmac } = await import("node:crypto");
    const { getEnv } = await import("@appstrate/env");
    const exp = Math.floor(Date.now() / 1000) - 60;
    const payload = `${closedOrgClientId}.${exp}`;
    const sig = createHmac("sha256", getEnv().BETTER_AUTH_SECRET)
      .update(payload)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const headers = new Headers({
      cookie: `oidc_pending_client=${payload}.${sig}`,
    });
    await expect(
      oidcBeforeSignupGuard({ user: { email: "stale@example.com" }, headers }),
    ).resolves.toBeUndefined();
  });

  it("pass-through when the pending client is application-level", async () => {
    await expect(
      oidcBeforeSignupGuard({
        user: { email: "app@example.com" },
        headers: await signedCookieHeader(appClientId),
      }),
    ).resolves.toBeUndefined();
  });

  it("pass-through on an org-level client with allowSignup=true", async () => {
    await expect(
      oidcBeforeSignupGuard({
        user: { email: "open@example.com" },
        headers: await signedCookieHeader(openOrgClientId),
      }),
    ).resolves.toBeUndefined();
  });

  describe("oidcAfterSignupHandler", () => {
    // The after handler runs on EVERY signup including ones that opt out of
    // the before guard — it auto-joins the freshly created BA user to the
    // org pinned by the cookie when the client's policy is open. This is
    // the fix for the social sign-in flow where `buildOrgLevelClaims` at
    // /token mint is too late: the BA session has no membership yet when
    // the browser transits `/api/auth/oauth2/authorize`.

    it("no-op when no cookie is present", async () => {
      const signupUser = await createTestUser({ email: "solo@example.com" });
      await expect(
        oidcAfterSignupHandler({
          user: { id: signupUser.id, email: "solo@example.com" },
          headers: null,
        }),
      ).resolves.toBeUndefined();
    });

    it("no-op when the pending client is application-level", async () => {
      const signupUser = await createTestUser({ email: "appsignup@example.com" });
      await oidcAfterSignupHandler({
        user: { id: signupUser.id, email: "appsignup@example.com" },
        headers: await signedCookieHeader(appClientId),
      });
      const rows = await db
        .select()
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, signupUser.id));
      expect(rows.length).toBe(0);
    });

    it("auto-joins the new user when the client has allowSignup=true", async () => {
      const signupUser = await createTestUser({ email: "fresh@example.com" });
      await oidcAfterSignupHandler({
        user: { id: signupUser.id, email: "fresh@example.com" },
        headers: await signedCookieHeader(openOrgClientId),
      });
      const [row] = await db
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, signupUser.id),
            eq(organizationMembers.orgId, ctx.orgId),
          ),
        );
      expect(row?.role).toBe("member");
    });

    it("is defensive when reached with allowSignup=false (no throw, no row)", async () => {
      // The before guard should have thrown, but if we somehow get here
      // with a closed policy we must not throw a second time.
      const signupUser = await createTestUser({ email: "unreachable@example.com" });
      await expect(
        oidcAfterSignupHandler({
          user: { id: signupUser.id, email: "unreachable@example.com" },
          headers: await signedCookieHeader(closedOrgClientId),
        }),
      ).resolves.toBeUndefined();
      const rows = await db
        .select()
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, signupUser.id));
      expect(rows.length).toBe(0);
    });
  });

  it("throws signup_disabled APIError on org-level + allowSignup=false", async () => {
    let caught: unknown;
    try {
      await oidcBeforeSignupGuard({
        user: { email: "rejected@example.com" },
        headers: await signedCookieHeader(closedOrgClientId),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(APIError);
    const apiErr = caught as APIError;
    // Body.message is what flows through BA's catch at link-account.mjs →
    // callback.mjs as `result.error`. Must be a non-empty string.
    const body = apiErr.body as { message?: string; code?: string } | undefined;
    expect(body?.message).toBe("signup_disabled");
    expect(body?.code).toBe("signup_disabled");
    // `.message` on the Error itself must also be set (super(body.message)).
    expect((apiErr as Error).message).toBe("signup_disabled");
  });
});
