// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-activation on connect is gated on `integrations:install` — the HTTP
 * proof that the shortcut never GRANTS a capability the caller lacks.
 *
 * `MEMBER_PERMISSIONS` holds `integrations:connect` + `integrations:disconnect`
 * but NOT `integrations:install` ("install/uninstall is admin"). Connecting a
 * credential is a personal act; activating an integration installs it for every
 * actor and every agent in the application. Without this gate, any member — and
 * any END-USER coming through the unauthenticated hosted portal — could perform
 * an admin-only tenant-wide mutation just by pasting an API key.
 *
 * The decision is taken at the route (the only layer that knows the caller's
 * permissions) and threaded down as an explicit boolean. For the two surfaces
 * that persist WITHOUT a session — the stateless OAuth callback and the hosted
 * connect form — it is captured at initiate/mint time and carried inside the
 * signed OAuth state / connect-session token, so it can be neither re-derived
 * from an absent session nor forged by the browser.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  createTestUser,
  addOrgMember,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedApiKey, seedEndUser } from "../../helpers/seed.ts";
import { applicationPackages, auditEvents } from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();
const INTEGRATION = "@myorg/firecrawl";

function apiKeyManifest(): IntegrationManifest {
  return localIntegrationManifest({
    name: INTEGRATION,
    version: "0.1.0",
    displayName: "Firecrawl",
    description: "Firecrawl integration",
    auths: {
      api: {
        type: "api_key",
        authorizedUris: ["https://api.firecrawl.dev/**"],
        delivery: httpHeaderDelivery({ name: "Authorization", prefix: "Bearer", field: "api_key" }),
      },
    },
  });
}

describe("auto-activation on connect — capability gate", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: apiKeyManifest(),
    });
  });

  function installRows() {
    return db
      .select()
      .from(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, ctx.defaultAppId),
          eq(applicationPackages.packageId, INTEGRATION),
        ),
      );
  }

  function activationAudits() {
    return db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.orgId, ctx.orgId),
          eq(auditEvents.action, "integration.activated"),
          eq(auditEvents.resourceId, INTEGRATION),
        ),
      );
  }

  function connectAs(headers: Record<string, string>) {
    return app.request(`/api/integrations/${INTEGRATION}/auths/api/connect/fields`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "fc-SECRET" } }),
    });
  }

  it("activates when an OWNER connects (holds integrations:install)", async () => {
    const res = await connectAs(authHeaders(ctx));
    expect(res.status).toBe(200);

    const rows = await installRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(true);
    expect(await activationAudits()).toHaveLength(1);
  });

  it("does NOT activate when a plain MEMBER connects", async () => {
    // A member clears `requirePermission("integrations","connect")` — the
    // connection is created — but holds no `integrations:install`, so the
    // application-wide install must not happen.
    const member = await createTestUser({ email: "member@myorg.test" });
    await addOrgMember(ctx.orgId, member.id, "member");

    const res = await connectAs({
      Cookie: member.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Application-Id": ctx.defaultAppId,
    });
    expect(res.status).toBe(200);

    expect(await installRows()).toHaveLength(0);
    expect(await activationAudits()).toHaveLength(0);
  });

  it("does NOT activate for an API key scoped to connect only, even when its creator is an owner", async () => {
    // `resolveApiKeyPermissions` intersects the key's scopes with the creator's
    // role. Reading the resolved request permissions (not the creator's role)
    // is what keeps a narrowly-scoped key narrow.
    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
      name: "connect-only-key",
      scopes: ["integrations:connect"],
    });

    const res = await connectAs({
      Authorization: `Bearer ${key.rawKey}`,
      "X-Org-Id": ctx.orgId,
      "X-Application-Id": ctx.defaultAppId,
    });
    expect(res.status).toBe(200);

    expect(await installRows()).toHaveLength(0);
    expect(await activationAudits()).toHaveLength(0);
  });

  it("activates for an API key that DOES carry integrations:install", async () => {
    // The complement of the previous case: the gate reads the key's real
    // grants, so a key that legitimately holds the install scope still works.
    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
      name: "full-key",
      scopes: ["integrations:connect", "integrations:install"],
    });

    const res = await connectAs({
      Authorization: `Bearer ${key.rawKey}`,
      "X-Org-Id": ctx.orgId,
      "X-Application-Id": ctx.defaultAppId,
    });
    expect(res.status).toBe(200);

    expect(await installRows()).toHaveLength(1);
    expect(await activationAudits()).toHaveLength(1);
  });

  it("does NOT activate for an END-USER, even under a key holding integrations:install", async () => {
    // End-users are not org members and hold no org role. They must never
    // mutate what the application has installed, whatever the key they ride on.
    const endUser = await seedEndUser({
      applicationId: ctx.defaultAppId,
      orgId: ctx.orgId,
      externalId: "ext-eu-activate",
    });
    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id,
      name: "impersonation-key",
      scopes: ["integrations:connect", "integrations:install"],
    });

    const res = await connectAs({
      Authorization: `Bearer ${key.rawKey}`,
      "X-Application-Id": ctx.defaultAppId,
      "Appstrate-User": endUser.id,
    });
    expect(res.status).toBe(200);

    expect(await installRows()).toHaveLength(0);
    expect(await activationAudits()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Hosted connect portal — the capability must survive the token hop
// ─────────────────────────────────────────────────────────────────────────

describe("auto-activation on connect — hosted portal carries the capability", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: apiKeyManifest(),
    });
  });

  /** Mint → dispatch → submit, returning the resulting page cookie flow status. */
  async function hostedConnect(mintHeaders: Record<string, string>): Promise<number> {
    const mint = await app.request(`/api/integrations/${INTEGRATION}/auths/api/connect/session`, {
      method: "POST",
      headers: { ...mintHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(mint.status).toBe(200);
    const { connect_url } = (await mint.json()) as { connect_url: string };
    const token = new URL(connect_url).searchParams.get("token")!;

    const start = await app.request(
      `/api/integrations/connect/start?token=${encodeURIComponent(token)}`,
      { redirect: "manual" },
    );
    expect(start.status).toBe(302);
    const cookieValue = start.headers.get("set-cookie")!.match(/appstrate_connect=([^;]+)/)![1]!;
    const cookie = `appstrate_connect=${cookieValue}`;

    const context = (await (
      await app.request("/api/integrations/connect/context", { headers: { Cookie: cookie } })
    ).json()) as { csrf: string };

    const submit = await app.request("/api/integrations/connect/submit", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "x-connect-csrf": context.csrf,
      },
      body: JSON.stringify({ credentials: { api_key: "fc-SECRET" } }),
    });
    return submit.status;
  }

  function installRows() {
    return db
      .select()
      .from(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, ctx.defaultAppId),
          eq(applicationPackages.packageId, INTEGRATION),
        ),
      );
  }

  it("activates when the session was minted by an owner", async () => {
    // The submit request itself is unauthenticated — the capability rides the
    // signed token minted by the owner, through the token → page-cookie hop.
    expect(await hostedConnect(authHeaders(ctx))).toBe(200);
    const rows = await installRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(true);
  });

  it("does NOT activate when the session was minted by a plain member", async () => {
    const member = await createTestUser({ email: "hosted-member@myorg.test" });
    await addOrgMember(ctx.orgId, member.id, "member");

    const status = await hostedConnect({
      Cookie: member.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Application-Id": ctx.defaultAppId,
    });
    expect(status).toBe(200);
    expect(await installRows()).toHaveLength(0);
  });
});
