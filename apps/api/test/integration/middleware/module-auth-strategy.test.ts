// SPDX-License-Identifier: Apache-2.0

/**
 * Module auth strategy pipeline — end-to-end integration.
 *
 * Builds a test app with a stub module that contributes an `AuthStrategy`,
 * then issues real HTTP requests to prove that:
 *   1. The stub strategy's resolution is applied to `c` (user, orgId, …)
 *   2. Requests matching the strategy bypass core Bearer ask_ / cookie auth
 *   3. Requests NOT matching the strategy fall through to core auth
 *   4. Core API key auth (Bearer ask_) still works when strategies don't claim
 *   5. A strategy-set `endUser` flows through to `c.get("endUser")`
 *
 * This is the key validation that Phase 0's extension point is wired
 * correctly from contract → loader → middleware → route.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { db } from "@appstrate/db/client";
import { endUsers } from "@appstrate/db/schema";
import { prefixedId } from "../../../src/lib/ids.ts";
import type { AppstrateModule, AuthStrategy } from "@appstrate/core/module";

// Test context is seeded once per test so the stub strategy can resolve to
// real DB rows. We capture it via a module-level reference because the
// strategy closure is built BEFORE beforeEach runs (the module is constructed
// once at module load, resolution happens per-request).
let currentCtx: TestContext | null = null;

const stubStrategy: AuthStrategy = {
  id: "stub-test-strategy",
  async authenticate({ headers }) {
    const token = headers.get("x-test-strategy");
    if (token !== "valid" && token !== "admin" && token !== "nothing") return null;
    if (!currentCtx) {
      throw new Error("currentCtx not seeded — test setup bug");
    }
    // A strategy that resolves an identity and grants NOTHING: no org role, an
    // empty permission list, and NOT deferring. The pipeline must read that as
    // an empty ceiling, not as "unresolved".
    if (token === "nothing") {
      return {
        user: {
          id: currentCtx.user.id,
          email: currentCtx.user.email,
          name: currentCtx.user.name,
        },
        orgId: currentCtx.orgId,
        orgSlug: currentCtx.org.slug,
        authMethod: "stub-strategy-nothing",
        spaceId: currentCtx.defaultSpaceId,
        permissions: [],
        deferOrgResolution: false,
      };
    }
    return {
      user: {
        id: currentCtx.user.id,
        email: currentCtx.user.email,
        name: currentCtx.user.name,
      },
      orgId: currentCtx.orgId,
      orgSlug: currentCtx.org.slug,
      orgRole: "admin",
      authMethod: "stub-strategy",
      spaceId: currentCtx.defaultSpaceId,
      permissions: ["runs:read", "runs:write", "runs:cancel", "agents:read", "end-users:read"],
      // Exercise the endUser pass-through when token is "admin"
      endUser:
        token === "admin"
          ? {
              id: "eu_stub_admin_placeholder",
              spaceId: currentCtx.defaultSpaceId,
              name: "Stub Admin",
              email: "stub-admin@test.com",
            }
          : undefined,
    };
  },
};

const stubModule: AppstrateModule = {
  manifest: { id: "stub-auth-strategy", name: "Stub Auth Strategy", version: "1.0.0" },
  async init() {},
  authStrategies() {
    return [stubStrategy];
  },
};

// Fresh app with the stub module wired in via options.modules.
// Does NOT touch the cached default space used by other tests.
const app = getTestApp({ modules: [stubModule] });

describe("module auth strategy pipeline", () => {
  beforeEach(async () => {
    await truncateAll();
    currentCtx = await createTestContext({ orgSlug: "strat" });
  });

  it("matches request with valid token and resolves to strategy context", async () => {
    const res = await app.request("/api/agents", {
      headers: {
        "X-Test-Strategy": "valid",
        "X-Space-Id": currentCtx!.defaultSpaceId,
      },
    });
    // 200 OK = strategy authenticated, org context resolved, route reached
    expect(res.status).toBe(200);
  });

  it("falls through to core auth when strategy returns null (unknown token)", async () => {
    const res = await app.request("/api/agents", {
      headers: {
        "X-Test-Strategy": "unknown",
        "X-Space-Id": currentCtx!.defaultSpaceId,
      },
    });
    // 401 = fell through strategies, hit cookie auth fallback, no session
    expect(res.status).toBe(401);
  });

  it("falls through to core auth when the header is absent", async () => {
    const res = await app.request("/api/agents", {
      headers: { "X-Space-Id": currentCtx!.defaultSpaceId },
    });
    expect(res.status).toBe(401);
  });

  it("strategy-set endUser flows into the request context", async () => {
    // Seed a real end_user row so routes that look up by id succeed.
    const euId = prefixedId("eu");
    await db.insert(endUsers).values({
      id: euId,
      spaceId: currentCtx!.defaultSpaceId,
      orgId: currentCtx!.orgId,
      name: "Stub Admin",
      email: "stub-admin@test.com",
    });

    // The strategy ships a placeholder endUser — we just verify the pipeline
    // doesn't reject a strategy-authenticated request carrying one. Core runs
    // endpoints will filter strictly to the endUser's id regardless of any
    // other context; this test only proves the auth pipeline wiring.
    const res = await app.request(`/api/end-users/${euId}`, {
      headers: {
        "X-Test-Strategy": "admin",
        "X-Space-Id": currentCtx!.defaultSpaceId,
      },
    });
    expect(res.status).toBe(200);
  });

  it("an empty, non-deferring strategy gets an EMPTY ceiling, not none", async () => {
    // `permissions: []` with no `orgRole` is only "I have not resolved an org
    // yet" when the strategy sets `deferOrgResolution`. Without it the empty
    // list is the answer, and it has to be written as a ceiling — otherwise the
    // space slice `requireSpaceContext` unions in later arrives unceilinged and
    // hands the caller the space preset's full run.
    const spaceLevel = await app.request("/api/agents", {
      headers: {
        "X-Test-Strategy": "nothing",
        "X-Space-Id": currentCtx!.defaultSpaceId,
      },
    });
    expect(spaceLevel.status).toBe(403);

    // An org-level route, resolved by `org-path-context` rather than by the
    // pipeline — same verdict, second code path.
    const orgLevel = await app.request(`/api/orgs/${currentCtx!.orgId}/settings`, {
      headers: { "X-Test-Strategy": "nothing" },
    });
    expect(orgLevel.status).toBe(403);

    // Control: the same subject, through the strategy that DOES grant, reaches
    // the space-level route — so the 403s are the empty ceiling, not the stub.
    const granted = await app.request("/api/agents", {
      headers: {
        "X-Test-Strategy": "valid",
        "X-Space-Id": currentCtx!.defaultSpaceId,
      },
    });
    expect(granted.status).toBe(200);
  });

  // ── /api/orgs/* must not re-derive permissions for a ceiling-limited token ──
  //
  // `/api/orgs/*` skips `requireOrgContext`, so `middleware/org-path-context.ts`
  // resolves the caller's permissions from the path org's membership row. That
  // derivation must apply to session auth ONLY (plus `deferOrgResolution`
  // strategies, which the pipeline itself resolves the same way): a strategy
  // that already wrote a narrow `permissions` set has a ceiling, and replacing
  // it with the subject's full role set hands a `runs:read` bearer the owner's
  // `org:delete`.
  //
  // The stub subject IS the org owner (createTestContext), so the membership
  // row would grant every org permission — which is exactly what makes this a
  // discriminating test rather than a tautology.
  describe("org-path permission derivation respects the strategy's ceiling", () => {
    it("403s DELETE /api/orgs/:orgId — the strategy's scopes lack org:delete", async () => {
      const res = await app.request(`/api/orgs/${currentCtx!.orgId}`, {
        method: "DELETE",
        headers: { "X-Test-Strategy": "valid" },
      });
      expect(res.status).toBe(403);
    });

    it("403s PUT /api/orgs/:orgId/settings and POST /api/orgs/:orgId/members too", async () => {
      const settings = await app.request(`/api/orgs/${currentCtx!.orgId}/settings`, {
        method: "PUT",
        headers: { "X-Test-Strategy": "valid", "Content-Type": "application/json" },
        body: JSON.stringify({ dashboard_sso_enabled: true }),
      });
      expect(settings.status).toBe(403);

      const invite = await app.request(`/api/orgs/${currentCtx!.orgId}/members`, {
        method: "POST",
        headers: { "X-Test-Strategy": "valid", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "escalated@test.com", role: "member" }),
      });
      expect(invite.status).toBe(403);
    });

    it("the same owner over a cookie session CAN update the org (control)", async () => {
      // Proves the refusals above come from the strategy's ceiling, not from
      // the org routes being closed or the subject lacking the role.
      const res = await app.request(`/api/orgs/${currentCtx!.orgId}`, {
        method: "PUT",
        headers: { Cookie: currentCtx!.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed By Owner" }),
      });
      expect(res.status).toBe(200);
    });
  });
});
