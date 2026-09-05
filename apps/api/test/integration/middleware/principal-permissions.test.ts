// SPDX-License-Identifier: Apache-2.0

/**
 * Per-principal org-level grants, end to end (RBAC spec §4.2).
 *
 * A stub module declares `principalPermissions` and grants two session-only
 * org-level strings to ONE user of the org. The assertions prove the four
 * properties the surface exists for: the grant reaches that user's session
 * through both permission-resolution paths (the `X-Org-Id` pipeline and the
 * `/api/orgs/:orgId` path resolver), it does NOT reach another member, it
 * cannot be delegated to an API key, and a module that misbehaves — an
 * undeclared string, a throwing resolver — costs the caller nothing.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { getDiscoveredModules } from "../../helpers/test-modules.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedSpaceMember } from "../../helpers/seed.ts";
import { invalidatePrincipalPermissions } from "@appstrate/core/principal-permissions";
import type { AppstrateModule } from "@appstrate/core/module";

/** `orgId:userId` → what the stub resolver answers. Rewritten per test. */
const answers = new Map<string, string[]>();
/** Flipped by the isolation test — the resolver throws for every principal. */
let resolverThrows = false;
/** Every principal the resolver was asked about, in order. Reset per test. */
const resolverCalls: string[] = [];

const principalModule: AppstrateModule = {
  manifest: { id: "stub-principal-grants", name: "Stub Principal Grants", version: "1.0.0" },
  async init() {},
  principalPermissions: {
    // Both org-level and both session-only: `model-provider-credentials:read`
    // gates a route reached through `X-Org-Id`, `org:settings` one reached
    // through `/api/orgs/:orgId`, so the two resolution paths are both covered.
    mayGrant: ["model-provider-credentials:read", "org:settings"],
    async resolve({ orgId, userId }) {
      resolverCalls.push(`${orgId}:${userId}`);
      if (resolverThrows) throw new Error("stub resolver is down");
      return answers.get(`${orgId}:${userId}`) ?? [];
    },
  },
};

const app = getTestApp({ modules: [...getDiscoveredModules(), principalModule] });

/** Session headers for a user other than the context's owner. */
function headersFor(ctx: TestContext, cookie: string): Record<string, string> {
  return { Cookie: cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": ctx.defaultSpaceId };
}

describe("per-principal org permissions", () => {
  let ctx: TestContext;
  let granted: Awaited<ReturnType<typeof createTestUser>>;
  let plain: Awaited<ReturnType<typeof createTestUser>>;

  beforeEach(async () => {
    await truncateAll();
    answers.clear();
    resolverThrows = false;
    ctx = await createTestContext();
    granted = await createTestUser();
    plain = await createTestUser();
    await addOrgMember(ctx.orgId, granted.id, "member");
    await addOrgMember(ctx.orgId, plain.id, "member");
    answers.set(`${ctx.orgId}:${granted.id}`, ["model-provider-credentials:read", "org:settings"]);
  });

  it("grants the permission on an org route to the named principal only", async () => {
    const ok = await app.request("/api/model-provider-credentials", {
      headers: headersFor(ctx, granted.cookie),
    });
    expect(ok.status).toBe(200);

    const denied = await app.request("/api/model-provider-credentials", {
      headers: headersFor(ctx, plain.cookie),
    });
    expect(denied.status).toBe(403);
  });

  it("grants it on the /api/orgs/:orgId path resolver too", async () => {
    const ok = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
      method: "PUT",
      headers: { Cookie: granted.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(ok.status).toBe(200);

    const denied = await app.request(`/api/orgs/${ctx.orgId}/settings`, {
      method: "PUT",
      headers: { Cookie: plain.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(denied.status).toBe(403);
  });

  it("surfaces the grant in the org listing, for that principal only", async () => {
    const mine = (await (
      await app.request("/api/orgs", { headers: { Cookie: granted.cookie } })
    ).json()) as { data: Array<{ id: string; permissions: string[] }> };
    const theirs = (await (
      await app.request("/api/orgs", { headers: { Cookie: plain.cookie } })
    ).json()) as { data: Array<{ id: string; permissions: string[] }> };

    expect(mine.data[0]!.permissions).toContain("model-provider-credentials:read");
    expect(theirs.data[0]!.permissions).not.toContain("model-provider-credentials:read");
    // Role grants are untouched on both sides — the union added, never replaced.
    expect(mine.data[0]!.permissions).toContain("models:read");
    expect(theirs.data[0]!.permissions).toContain("models:read");
  });

  it("answers the same set on /api/me/orgs", async () => {
    const body = (await (
      await app.request("/api/me/orgs", { headers: { Cookie: granted.cookie } })
    ).json()) as { data: Array<{ permissions: string[] }> };
    expect(body.data[0]!.permissions).toContain("model-provider-credentials:read");
  });

  it("refuses the granted string as an API-key scope at mint time", async () => {
    // The principal holds `model-provider-credentials:read` in this session and
    // holds `api-keys:create` in the space, so nothing but the session-only
    // rule can be what refuses the scope.
    await seedSpaceMember({
      spaceId: ctx.defaultSpaceId,
      userId: granted.id,
      presetRole: "admin",
    });

    const res = await app.request("/api/api-keys", {
      method: "POST",
      headers: { ...headersFor(ctx, granted.cookie), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Delegated Key",
        scopes: ["model-provider-credentials:read"],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_request");
  });

  it("drops a string the module never declared in mayGrant", async () => {
    answers.set(`${ctx.orgId}:${granted.id}`, ["proxies:delete"]);

    const body = (await (
      await app.request("/api/orgs", { headers: { Cookie: granted.cookie } })
    ).json()) as { data: Array<{ permissions: string[] }> };
    expect(body.data[0]!.permissions).not.toContain("proxies:delete");
    // Positive control: the same request DOES carry a declared string.
    answers.set(`${ctx.orgId}:${granted.id}`, ["model-provider-credentials:read"]);
    invalidatePrincipalPermissions(ctx.orgId, granted.id);
    const after = (await (
      await app.request("/api/orgs", { headers: { Cookie: granted.cookie } })
    ).json()) as { data: Array<{ permissions: string[] }> };
    expect(after.data[0]!.permissions).toContain("model-provider-credentials:read");
  });

  it("serves the request with role permissions when the resolver throws", async () => {
    resolverThrows = true;

    const res = await app.request("/api/orgs", { headers: { Cookie: granted.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ permissions: string[] }> };
    expect(body.data[0]!.permissions).toContain("models:read");
    expect(body.data[0]!.permissions).not.toContain("model-provider-credentials:read");
  });

  it("keeps the answer until the module invalidates it", async () => {
    const first = await app.request("/api/model-provider-credentials", {
      headers: headersFor(ctx, granted.cookie),
    });
    expect(first.status).toBe(200);

    answers.set(`${ctx.orgId}:${granted.id}`, []);
    const stale = await app.request("/api/model-provider-credentials", {
      headers: headersFor(ctx, granted.cookie),
    });
    expect(stale.status).toBe(200); // cached — the module has not said otherwise

    invalidatePrincipalPermissions(ctx.orgId, granted.id);
    const fresh = await app.request("/api/model-provider-credentials", {
      headers: headersFor(ctx, granted.cookie),
    });
    expect(fresh.status).toBe(403);
  });

  it("never grants it to an API key, and never even asks the module", async () => {
    // A 403 alone cannot fail here: `model-provider-credentials:read` is not
    // in the API-key allowlist, so the key is refused whatever the resolver
    // says and the assertion would pass with the eligibility rule deleted.
    // The discriminating fact is that the resolver is NOT CONSULTED for a key
    // — that is the rule `lib/principal-permissions.ts` implements, and the
    // call counter is the only thing that sees it.
    await seedSpaceMember({
      spaceId: ctx.defaultSpaceId,
      userId: granted.id,
      presetRole: "admin",
    });
    const minted = await app.request("/api/api-keys", {
      method: "POST",
      headers: { ...headersFor(ctx, granted.cookie), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Broad Key" }),
    });
    expect(minted.status).toBe(201);
    const { key } = (await minted.json()) as { key: string };

    resolverCalls.length = 0;
    const res = await app.request("/api/model-provider-credentials", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
    expect(resolverCalls).toEqual([]);

    // Positive control on the counter itself: the SAME principal, as a
    // session, does reach the resolver — so the empty list above is the
    // eligibility rule and not a spy that never fires. The invalidation is
    // required: the mint request above was a session, so its answer is still
    // in the 10s cache and the control would read as "never called".
    invalidatePrincipalPermissions(ctx.orgId, granted.id);
    resolverCalls.length = 0;
    await app.request("/api/model-provider-credentials", {
      headers: headersFor(ctx, granted.cookie),
    });
    expect(resolverCalls).toContain(`${ctx.orgId}:${granted.id}`);
  });
});
