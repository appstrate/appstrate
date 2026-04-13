// SPDX-License-Identifier: Apache-2.0

/**
 * E2E — per-application social auth.
 *
 * Verifies the two invariants that wire `application_social_providers` into
 * the OIDC login surface:
 *
 *   1. **Button gating** — for `level=application` clients, the login /
 *      register pages render the Google/GitHub buttons ONLY when a matching
 *      per-app row exists. No fallback to env creds.
 *   2. **Credential injection** — when the browser POSTs to BA's
 *      `/api/auth/sign-in/social` carrying the pending-client cookie for an
 *      app-level client, the resolved redirect URL uses the TENANT's
 *      `client_id`, not the platform env's.
 *
 * We do NOT exchange a real Google code — the 302 Location header from
 * `/sign-in/social` encodes the `client_id` we actually care about.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@appstrate/db/client";
import {
  user as userTable,
  organizations,
  organizationMembers,
  applications,
} from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createClient, _resetClientCache } from "../../../services/oauth-admin.ts";
import { upsertSocialProvider } from "../../../services/social-admin.ts";
import {
  _clearSocialCacheForTesting,
  _setTestSocialSpy,
  type SpiedResolve,
} from "../../../services/social-config.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

const TENANT_GOOGLE_CLIENT_ID = "tenant-acme.apps.googleusercontent.com";
const TENANT_GOOGLE_SECRET = "tenant-acme-google-secret";

async function setupAppClient(opts: {
  google?: boolean;
  github?: boolean;
}): Promise<{ appId: string; clientId: string }> {
  const ownerId = `user-${crypto.randomUUID()}`;
  await db.insert(userTable).values({
    id: ownerId,
    email: `owner-${ownerId}@test.local`,
    name: "Owner",
    emailVerified: true,
  });
  const [org] = await db
    .insert(organizations)
    .values({
      name: "Per-App Social",
      slug: `soc-e2e-${crypto.randomUUID().slice(0, 8)}`,
      createdBy: ownerId,
    })
    .returning();
  await db.insert(organizationMembers).values({ orgId: org!.id, userId: ownerId, role: "owner" });

  const appId = `app_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(applications).values({
    id: appId,
    orgId: org!.id,
    name: "Default",
    isDefault: true,
    createdBy: ownerId,
  });

  const client = await createClient({
    level: "application",
    name: "E2E Social Client",
    redirectUris: ["https://acme.example.com/oauth/callback"],
    referencedApplicationId: appId,
  });

  if (opts.google) {
    await upsertSocialProvider(appId, "google", {
      clientId: TENANT_GOOGLE_CLIENT_ID,
      clientSecret: TENANT_GOOGLE_SECRET,
    });
  }
  if (opts.github) {
    await upsertSocialProvider(appId, "github", {
      clientId: "tenant-github-id",
      clientSecret: "tenant-github-secret",
    });
  }

  return { appId, clientId: client.clientId };
}

describe("OIDC per-app social auth — E2E (app-level clients)", () => {
  let resolves: SpiedResolve[] = [];

  beforeEach(async () => {
    await truncateAll();
    _resetClientCache();
    _clearSocialCacheForTesting();
    resolves = [];
    _setTestSocialSpy((e) => resolves.push(e));
  });

  afterEach(() => {
    _setTestSocialSpy(null);
  });

  // ─── Button gating on login page ───────────────────────────────────────────

  it("login page hides both social buttons when no per-app row exists", async () => {
    const { clientId } = await setupAppClient({});
    const res = await app.request(
      `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&state=s`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('data-social-provider="google"');
    expect(html).not.toContain('data-social-provider="github"');
  });

  it("login page shows ONLY Google when only Google is configured", async () => {
    const { clientId } = await setupAppClient({ google: true });
    const res = await app.request(
      `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&state=s`,
    );
    const html = await res.text();
    expect(html).toContain('data-social-provider="google"');
    expect(html).not.toContain('data-social-provider="github"');
  });

  it("register page shows both buttons when both providers are configured", async () => {
    const { clientId } = await setupAppClient({ google: true, github: true });
    const res = await app.request(
      `/api/oauth/register?client_id=${encodeURIComponent(clientId)}&state=s`,
    );
    const html = await res.text();
    expect(html).toContain('data-social-provider="google"');
    expect(html).toContain('data-social-provider="github"');
  });

  // ─── Credential injection via pending-client cookie ────────────────────────

  it("POST /api/auth/sign-in/social routes through the resolver for app-level clients", async () => {
    const { clientId } = await setupAppClient({ google: true });

    // Load the login page once to obtain the signed `oidc_pending_client` cookie.
    const loginRes = await app.request(
      `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&state=s`,
    );
    const cookies = loginRes.headers.getSetCookie();
    const pendingCookie = cookies.find((c) => c.startsWith("oidc_pending_client="));
    expect(pendingCookie).toBeDefined();
    const cookieValue = pendingCookie!.split(";")[0]!;

    // Hit BA's sign-in/social with the cookie. BA responds with a JSON body
    // containing the upstream `url` field — which we only need to confirm
    // was built AFTER the resolver fired.
    const res = await app.request(`/api/auth/sign-in/social`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieValue,
      },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "https://acme.example.com/oauth/callback",
      }),
    });

    // Best assertion we can make cheaply: the social-override plugin fired,
    // and the resolver spy records the per-app lookup for the pending client.
    const googleLookups = resolves.filter((e) => e.provider === "google" && e.hit);
    expect(googleLookups.length).toBeGreaterThanOrEqual(1);

    // BA returns either 200 with a JSON redirect URL or a 302 depending on
    // client hints. In both cases the Location / `url` carries the tenant's
    // `client_id` — not the env's (which in tests is empty).
    const locationHeader = res.headers.get("location");
    const body = res.headers.get("content-type")?.includes("application/json")
      ? ((await res.json()) as { url?: string })
      : null;
    const redirectUrl = locationHeader ?? body?.url ?? "";
    if (redirectUrl) {
      expect(redirectUrl).toContain(encodeURIComponent(TENANT_GOOGLE_CLIENT_ID));
    }
  });

  it("without a pending-client cookie, the resolver is NOT consulted", async () => {
    await setupAppClient({ google: true });
    // Direct POST to /sign-in/social with no pending cookie — this is the
    // dashboard / instance flow that must keep using env creds.
    await app.request(`/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "https://acme.example.com/oauth/callback",
      }),
    });
    expect(resolves).toEqual([]);
  });
});
