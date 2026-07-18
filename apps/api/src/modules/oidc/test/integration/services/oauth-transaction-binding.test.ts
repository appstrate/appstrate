// SPDX-License-Identifier: Apache-2.0

/**
 * CRIT-15 closure — magic-link verify leg realm binding.
 *
 * The realm of a user created on `/magic-link/verify` must derive from the
 * server-side `(token → OAuth client)` binding persisted at issuance, never
 * from the ambient `oidc_pending_client` browser cookie: the caller controls
 * whether their browser presents the cookie (strip it → the old resolver
 * saw "no OIDC flow" and minted a full platform-realm user for an
 * application signup), and the single global cookie is clobbered by a
 * concurrent flow in a second tab.
 *
 * These tests drive `oidcRealmResolver` / `enforceMagicLinkSignupPolicy`
 * directly with the synthesized hook context Better Auth passes on the
 * verify leg (`path: "/magic-link/verify"`, `query.token`) — the same
 * pattern `signup-guard.test.ts` and `magic-link-signup-redirect.test.ts`
 * use, because the magic-link plugin only mounts its endpoints when SMTP is
 * configured and the test preload strips SMTP env.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { verification } from "@appstrate/db/schema";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestContext } from "../../../../../../test/helpers/auth.ts";
import { signAuthHmac } from "../../../../../lib/auth-secrets.ts";
import { createClient, _resetClientCache } from "../../../services/oauth-admin.ts";
import { oidcRealmResolver } from "../../../services/oidc-realm-resolver.ts";
import {
  persistMagicLinkClientBinding,
  MAGIC_LINK_VERIFY_PATH,
} from "../../../services/oauth-transaction-binding.ts";
import { enforceMagicLinkSignupPolicy } from "../../../auth/guards.ts";

/** Signed pending-client cookie, mirroring `services/pending-client-cookie.ts`. */
function pendingClientCookie(clientId: string): string {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const payload = `${clientId}.${exp}`;
  const sig = signAuthHmac(payload);
  return `oidc_pending_client=${payload}.${sig}`;
}

function verifyLegCtx(token: string, cookie?: string) {
  return {
    headers: cookie ? new Headers({ cookie }) : null,
    path: MAGIC_LINK_VERIFY_PATH,
    query: { token },
  };
}

describe("magic-link verify realm binding (CRIT-15)", () => {
  let appClientId: string;
  let applicationId: string;
  let orgId: string;

  beforeEach(async () => {
    await truncateAll();
    _resetClientCache();
    const ctx = await createTestContext({ orgSlug: "mlbind" });
    orgId = ctx.orgId;
    applicationId = ctx.defaultAppId;
    const created = await createClient({
      level: "application",
      name: "Binding App",
      redirectUris: ["https://rp.example.com/cb"],
      referencedApplicationId: applicationId,
      allowSignup: true,
    });
    appClientId = created.clientId;
  });

  it("resolves end_user realm from the token binding with NO cookie (stripped-cookie attack closed)", async () => {
    const token = `ml_${crypto.randomUUID()}`;
    await persistMagicLinkClientBinding(token, appClientId);

    const realm = await oidcRealmResolver(verifyLegCtx(token));
    expect(realm).toBe(`end_user:${applicationId}`);
  });

  it("token binding WINS over a conflicting cookie from a concurrent tab", async () => {
    const token = `ml_${crypto.randomUUID()}`;
    await persistMagicLinkClientBinding(token, appClientId);

    // Second tab started an org-level flow and clobbered the global cookie.
    const other = await createClient({
      level: "org",
      name: "Other Portal",
      redirectUris: ["https://other.example.com/cb"],
      referencedOrgId: orgId,
      allowSignup: true,
    });

    const realm = await oidcRealmResolver(verifyLegCtx(token, pendingClientCookie(other.clientId)));
    expect(realm).toBe(`end_user:${applicationId}`);
  });

  it("fails CLOSED when the binding names a client that no longer resolves", async () => {
    const token = `ml_${crypto.randomUUID()}`;
    await persistMagicLinkClientBinding(token, "oauth_deleted_client");

    await expect(oidcRealmResolver(verifyLegCtx(token))).rejects.toThrow("oidc_realm_unresolved");
  });

  it("resolves platform for a verify with no binding and no cookie (direct BA magic-link)", async () => {
    const realm = await oidcRealmResolver(verifyLegCtx(`ml_${crypto.randomUUID()}`));
    expect(realm).toBe("platform");
  });

  it("ignores an expired binding row", async () => {
    const token = `ml_${crypto.randomUUID()}`;
    // Insert an already-expired binding directly — `persistMagicLinkClientBinding`
    // always writes a future expiry, so mirror its key derivation here.
    const digest = new Bun.CryptoHasher("sha256").update(token).digest("hex");
    await db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: `oidc-pending-client:${digest}`,
      value: appClientId,
      expiresAt: new Date(Date.now() - 1000),
    });

    const realm = await oidcRealmResolver(verifyLegCtx(token));
    expect(realm).toBe("platform");
  });

  it("closed-signup gate fires from the binding alone (no cookie) on the verify pre-check", async () => {
    const closed = await createClient({
      level: "application",
      name: "Closed Binding App",
      redirectUris: ["https://rp.example.com/cb"],
      referencedApplicationId: applicationId,
      allowSignup: false,
    });
    const token = `ml_${crypto.randomUUID()}`;
    await persistMagicLinkClientBinding(token, closed.clientId);

    const baseURL = "http://localhost:3000";
    let redirectedTo: string | null = null;
    try {
      await enforceMagicLinkSignupPolicy({
        // No cookie header at all — the old cookie-based gate no-oped here.
        request: new Request(`${baseURL}/api/auth/magic-link/verify`),
        query: { token, callbackURL: `${baseURL}/cb` },
        context: {
          baseURL,
          internalAdapter: {
            findVerificationValue: async () => ({
              value: JSON.stringify({ email: "fresh-binding@example.com" }),
              expiresAt: new Date(Date.now() + 60_000),
            }),
            findUserByEmail: async () => null,
          },
        },
        redirect: (url: string) => {
          const sentinel: { redirectTo: string } = { redirectTo: url };
          throw sentinel;
        },
      });
    } catch (err) {
      redirectedTo = (err as { redirectTo?: string }).redirectTo ?? null;
    }

    expect(redirectedTo).not.toBeNull();
    expect(new URL(redirectedTo!).searchParams.get("error")).toBe("signup_disabled");
  });
});
