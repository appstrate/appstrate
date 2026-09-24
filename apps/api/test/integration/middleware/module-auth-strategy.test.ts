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
 *   6. A strategy that misdeclares its `principalKind` is a 500, not a bucket
 *   7. Identity-shaped gates read that kind, never the transport that carried it
 *
 * This is the key validation that Phase 0's extension point is wired
 * correctly from contract → loader → middleware → route.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestOrg, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpace } from "../../helpers/seed.ts";
import { ensurePersonalSpaceFor } from "../../../src/services/spaces.ts";
import { db } from "@appstrate/db/client";
import { endUsers, integrationConnections } from "@appstrate/db/schema";
import { prefixedId } from "@appstrate/db/ids";
import type { AppstrateModule, AuthResolution, AuthStrategy } from "@appstrate/core/module";

/**
 * Tokens that resolve to the `"valid"` shape carrying ONE deliberate defect in
 * its principal declaration. `principalKind` is required and must agree with
 * `endUser`, so the type system refuses each of them — which is precisely why
 * the pipeline's own runtime check has to be what answers.
 */
const MISDECLARED = ["no-kind", "kind-without-enduser", "enduser-without-kind"] as const;

/** The external identity the `"admin"` token impersonates; seeded where a test needs the row. */
const STUB_END_USER_ID = "eu_stub_admin_placeholder";

// Test context is seeded once per test so the stub strategy can resolve to
// real DB rows. We capture it via a module-level reference because the
// strategy closure is built BEFORE beforeEach runs (the module is constructed
// once at module load, resolution happens per-request).
let currentCtx: TestContext | null = null;

const stubStrategy: AuthStrategy = {
  id: "stub-test-strategy",
  async authenticate({ headers }) {
    const token = headers.get("x-test-strategy");
    if (token === "deferred") {
      // The shape the OIDC instance token has: the full user, no org pinned,
      // no ceiling — the CLI acting as the person. The pipeline treats it like
      // a session, which is what makes it eligible for a role preview.
      if (!currentCtx) throw new Error("currentCtx not seeded — test setup bug");
      return {
        user: {
          id: currentCtx.user.id,
          email: currentCtx.user.email,
          name: currentCtx.user.name,
        },
        authMethod: "stub-deferred",
        principalKind: "user",
        permissions: [],
        deferOrgResolution: true,
      };
    }
    if (token === "dashboard") {
      // The `oauth2-dashboard` shape: an org-bound DELEGATE with NO pinned
      // space — authority over the org, never the person behind it.
      if (!currentCtx) throw new Error("currentCtx not seeded — test setup bug");
      return {
        user: {
          id: currentCtx.user.id,
          email: currentCtx.user.email,
          name: currentCtx.user.name,
        },
        orgId: currentCtx.orgId,
        orgSlug: currentCtx.org.slug,
        orgRole: "admin",
        authMethod: "stub-dashboard",
        principalKind: "delegate",
        permissions: ["agents:read", "spaces:read", "integrations:read", "runs:read"],
      };
    }
    if (token === "dashboard-unbound") {
      // The same delegate with nothing to be bound BY: no org, no role, no
      // space, and NOT deferring — the pipeline writes its ceiling verbatim and
      // it reaches the org listings with nothing to filter by.
      if (!currentCtx) throw new Error("currentCtx not seeded — test setup bug");
      return {
        user: {
          id: currentCtx.user.id,
          email: currentCtx.user.email,
          name: currentCtx.user.name,
        },
        authMethod: "stub-dashboard-unbound",
        principalKind: "delegate",
        permissions: ["spaces:read"],
      };
    }
    const misdeclared = MISDECLARED.find((t) => t === token);
    if (token !== "valid" && token !== "admin" && !misdeclared) return null;
    if (!currentCtx) {
      throw new Error("currentCtx not seeded — test setup bug");
    }
    const resolution: AuthResolution = {
      user: {
        id: currentCtx.user.id,
        email: currentCtx.user.email,
        name: currentCtx.user.name,
      },
      orgId: currentCtx.orgId,
      orgSlug: currentCtx.org.slug,
      orgRole: "admin",
      authMethod: "stub-strategy",
      // "admin" is the branch carrying `endUser` below — the two must agree.
      principalKind: token === "admin" ? "end_user" : "delegate",
      spaceId: currentCtx.defaultSpaceId,
      // `spaces:write` is here so `POST /api/spaces` is refused by the KIND
      // rather than by the ceiling, which would refuse it either way;
      // `integrations:read` so `/api/me/connections` is decided by the binding.
      permissions: [
        "runs:read",
        "runs:write",
        "runs:cancel",
        "agents:read",
        "end-users:read",
        "spaces:write",
        "integrations:read",
      ],
      // Exercise the endUser pass-through when token is "admin"
      endUser:
        token === "admin"
          ? {
              id: STUB_END_USER_ID,
              spaceId: currentCtx.defaultSpaceId,
              name: "Stub Admin",
              email: "stub-admin@test.com",
            }
          : undefined,
    };
    if (!misdeclared) return resolution;
    const defect: Record<string, unknown> =
      misdeclared === "no-kind"
        ? { principalKind: undefined }
        : misdeclared === "kind-without-enduser"
          ? { principalKind: "end_user", endUser: undefined }
          : {
              principalKind: "user",
              endUser: {
                id: "eu_stub_contract",
                spaceId: currentCtx.defaultSpaceId,
                name: "Contract",
                email: "contract@test.com",
              },
            };
    return { ...resolution, ...defect } as unknown as AuthResolution;
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

    it("a deferOrgResolution strategy may carry a role preview, an inline one may not", async () => {
      // Eligibility is "did this credential authenticate the person" — a cookie
      // session or the CLI/instance token — not "is it a cookie".
      const previewed = await app.request("/api/spaces", {
        headers: {
          "X-Test-Strategy": "deferred",
          "X-Org-Id": currentCtx!.orgId,
          "X-View-As": `org_role=member; space=${currentCtx!.defaultSpaceId}; role=preset:viewer`,
        },
      });
      expect(previewed.status, await previewed.clone().text()).toBe(200);
      expect(previewed.headers.get("X-View-As-Active")).toBe("1");
      const listed = (await previewed.json()) as {
        data: Array<{ role: { key: string }; permissions: string[] }>;
      };
      expect(listed.data[0]?.role.key).toBe("viewer");
      expect(listed.data[0]?.permissions).not.toContain("agents:write");

      // The same strategy WITHOUT `deferOrgResolution` resolves its own org and
      // ceiling inline, so it carries no session to narrow.
      const refused = await app.request("/api/spaces", {
        headers: {
          "X-Test-Strategy": "valid",
          "X-View-As": "org_role=member",
        },
      });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { code: string }).code).toBe("view_as_unsupported");
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

  // ── Shared observations: the two listings a credential's reach shows up in ──

  /** One connection row on a freshly seeded integration, owned by user or end-user. */
  async function connectionIn(opts: {
    orgId: string;
    spaceId: string;
    integrationId: string;
    endUserId?: string;
  }): Promise<string> {
    await seedPackage({
      id: opts.integrationId,
      orgId: opts.orgId,
      homeSpaceId: opts.spaceId,
      type: "integration",
      source: "local",
    });
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: opts.integrationId,
        authKey: "primary",
        accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
        spaceId: opts.spaceId,
        userId: opts.endUserId ? null : currentCtx!.user.id,
        endUserId: opts.endUserId ?? null,
        credentialsEncrypted: "x",
        scopesGranted: [],
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  /** Same observation as `me.test.ts` CRIT-03: which connection ids surface. */
  async function connectionIds(token: string): Promise<string[]> {
    const res = await app.request("/api/me/connections", {
      headers: { "X-Test-Strategy": token },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ connections: Array<{ connection_id: string }> }>;
    };
    return body.data.flatMap((g) => g.connections.map((x) => x.connection_id));
  }

  async function orgIds(path: string, token: string): Promise<string[]> {
    const res = await app.request(path, { headers: { "X-Test-Strategy": token } });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { data: Array<{ id: string }> }).data.map((o) => o.id);
  }

  // ── The delegate that is NOT an API key ───────────────────────────────────
  //
  // Every gate below asked `authMethod === "api_key"`, so this stub — a
  // delegate by another transport, and an `admin` at that — walked through all
  // of them. Each one asks "is this the person?", so the kind must answer.
  describe("a delegate that is not an API key", () => {
    const delegate = { "X-Test-Strategy": "valid" };
    const json = { ...delegate, "Content-Type": "application/json" };

    it("cannot read or rewrite the dashboard user's own identity record", async () => {
      expect((await app.request("/api/profile", { headers: delegate })).status).toBe(403);

      const renamed = await app.request("/api/profile", {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ displayName: "Renamed By A Delegate" }),
      });
      expect(renamed.status).toBe(403);

      const password = await app.request("/api/profile/password", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ newPassword: "NotYourPassword123!" }),
      });
      expect(password.status).toBe(403);
    });

    it("cannot complete the onboarding step that renames the user", async () => {
      const res = await app.request("/api/welcome/setup", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ displayName: "Onboarded By A Delegate" }),
      });
      expect(res.status).toBe(403);
    });

    it("cannot make the two decisions a person makes, nor open the org-wide map", async () => {
      const space = await app.request("/api/spaces", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name: "Delegated Space" }),
      });
      expect(space.status).toBe(403);

      const org = await app.request("/api/orgs", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name: "Delegated Org", slug: "delegated-org" }),
      });
      expect(org.status).toBe(403);

      // The stub resolves to `admin`, which passes the role half of
      // `mayOpenOrganizationLibrary` — only the kind can refuse this one.
      expect((await app.request("/api/library", { headers: delegate })).status).toBe(403);
    });

    it("sees only its bound org in both listings, where a `user` sees both", async () => {
      await createTestOrg(currentCtx!.user.id);

      for (const path of ["/api/orgs", "/api/me/orgs"]) {
        expect(await orgIds(path, "valid")).toEqual([currentCtx!.orgId]);
        expect(await orgIds(path, "deferred")).toHaveLength(2);
      }
    });

    it("gets the bound connection view, where a `user` gets the global one", async () => {
      const here = await connectionIn({
        orgId: currentCtx!.orgId,
        spaceId: currentCtx!.defaultSpaceId,
        integrationId: "@strat/here",
      });
      const other = await createTestOrg(currentCtx!.user.id);
      const elsewhere = await connectionIn({
        orgId: other.org.id,
        spaceId: other.defaultSpaceId,
        integrationId: "@strat/elsewhere",
      });

      expect(await connectionIds("valid")).toEqual([here]);
      expect((await connectionIds("deferred")).sort()).toEqual([here, elsewhere].sort());
    });

    it("control: a `user` by another transport still reads its own profile", async () => {
      const res = await app.request("/api/profile", {
        headers: { "X-Test-Strategy": "deferred" },
      });
      expect(res.status, await res.clone().text()).toBe(200);
    });
  });

  // ── The org-bound delegate with no pinned space (`oauth2-dashboard`) ───────
  //
  // Org authority and nothing else: it holds `admin`, and the three reads below
  // are the ones that would hand it the person's own half of the org.
  describe("an org-bound delegate with no pinned space", () => {
    const dashboard = { "X-Test-Strategy": "dashboard" };

    it("is a 404 on the subject's own personal space, where their session is served", async () => {
      // Pins the refusal rather than a regression: `callerPersonalOwnerId` is
      // `null` for anything that is not the person, before and after.
      const personal = await ensurePersonalSpaceFor(currentCtx!.orgId, currentCtx!.user.id);
      const asDelegate = await app.request("/api/agents", {
        headers: { ...dashboard, "X-Space-Id": personal.id },
      });
      expect(asDelegate.status).toBe(404);

      const asUser = await app.request("/api/agents", {
        headers: {
          Cookie: currentCtx!.cookie,
          "X-Org-Id": currentCtx!.orgId,
          "X-Space-Id": personal.id,
        },
      });
      expect(asUser.status, await asUser.clone().text()).toBe(200);
    });

    it("cannot open the org-wide map its `admin` role would otherwise reach", async () => {
      expect((await app.request("/api/library", { headers: dashboard })).status).toBe(403);
    });

    it("is bound to its org in the listing and in its connections", async () => {
      const here = await connectionIn({
        orgId: currentCtx!.orgId,
        spaceId: currentCtx!.defaultSpaceId,
        integrationId: "@strat/dash-here",
      });
      const other = await createTestOrg(currentCtx!.user.id);
      await connectionIn({
        orgId: other.org.id,
        spaceId: other.defaultSpaceId,
        integrationId: "@strat/dash-elsewhere",
      });

      expect(await orgIds("/api/orgs", "dashboard")).toEqual([currentCtx!.orgId]);
      // Org-bound, not space-bound: it pins no space, so the whole org answers.
      expect(await connectionIds("dashboard")).toEqual([here]);
    });
  });

  // ── The delegate bound to nothing at all ──────────────────────────────────
  //
  // `/api/orgs` and `/api/me/orgs` skip org context by design, so this one
  // reaches `getUserOrganizations` with no id to narrow by. The only safe
  // answer is to refuse; on `main` it read every org the subject belongs to.
  describe("a delegate with no org binding", () => {
    it("is refused both org listings, where an unbound `user` is served", async () => {
      await createTestOrg(currentCtx!.user.id);

      for (const path of ["/api/orgs", "/api/me/orgs"]) {
        const refused = await app.request(path, {
          headers: { "X-Test-Strategy": "dashboard-unbound" },
        });
        expect(refused.status, await refused.clone().text()).toBe(401);
        // The same absence of an org on a `user` is the ordinary pre-org-picker
        // call, and still lists both.
        expect(await orgIds(path, "deferred")).toHaveLength(2);
      }
    });
  });

  // ── The end-user, whatever role its credential carries ────────────────────
  //
  // The `"admin"` token carries `orgRole: "admin"` AND an `endUser`. On `main`
  // every gate below read `authMethod`, saw `stub-strategy`, and let it write.
  describe("an end-user, whatever role its credential carries", () => {
    const impersonated = { "X-Test-Strategy": "admin" };
    const json = { ...impersonated, "Content-Type": "application/json" };

    it("makes none of the decisions that belong to a person", async () => {
      const org = await app.request("/api/orgs", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name: "End User Org", slug: "end-user-org" }),
      });
      expect(org.status).toBe(403);

      const space = await app.request("/api/spaces", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ name: "End User Space" }),
      });
      expect(space.status).toBe(403);

      const renamed = await app.request("/api/profile", {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ displayName: "Renamed By An End User" }),
      });
      expect(renamed.status).toBe(403);

      const password = await app.request("/api/profile/password", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ newPassword: "NotYourPassword123!" }),
      });
      expect(password.status).toBe(403);
    });

    it("sees only the connections of the space its credential pins", async () => {
      await db.insert(endUsers).values({
        id: STUB_END_USER_ID,
        spaceId: currentCtx!.defaultSpaceId,
        orgId: currentCtx!.orgId,
        name: "Stub Admin",
        email: "stub-admin@test.com",
      });
      const pinned = await connectionIn({
        orgId: currentCtx!.orgId,
        spaceId: currentCtx!.defaultSpaceId,
        integrationId: "@strat/eu-pinned",
        endUserId: STUB_END_USER_ID,
      });
      const sibling = await seedSpace({ orgId: currentCtx!.orgId, name: "Sibling" });
      await connectionIn({
        orgId: currentCtx!.orgId,
        spaceId: sibling.id,
        integrationId: "@strat/eu-elsewhere",
        endUserId: STUB_END_USER_ID,
      });

      // Same org, a second space: on `main` the global view returned both.
      expect(await connectionIds("admin")).toEqual([pinned]);
    });
  });

  // ── The principal contract: a misdeclared kind fails loud ──────────────────
  //
  // The kind is DECLARED now, not inferred from the transport, so a missing or
  // self-contradictory declaration is a programming error with no safe default:
  // bucketing it is how a server-minted bearer once stopped being its user.
  // The positive control is the suite's first test — the well-declared
  // `delegate` (`"valid"`) reaching `/api/agents` with a 200.
  describe("a strategy that misdeclares its principal", () => {
    const request = (token: string) =>
      app.request("/api/agents", {
        headers: { "X-Test-Strategy": token, "X-Space-Id": currentCtx!.defaultSpaceId },
      });

    it("500s a resolution that declares no kind at all", async () => {
      await expectProblem(await request("no-kind"), 500, { code: "internal_error" });
    });

    it("500s either half of an `end_user` disagreement", async () => {
      await expectProblem(await request("kind-without-enduser"), 500, { code: "internal_error" });
      await expectProblem(await request("enduser-without-kind"), 500, { code: "internal_error" });
    });

    it("tells the caller nothing about the throw", async () => {
      const body = await expectProblem(await request("no-kind"), 500, { code: "internal_error" });
      expect(body.detail).toBe("An internal error occurred");
      expect(JSON.stringify(body)).not.toContain("stub-test-strategy");
    });
  });
});
