// SPDX-License-Identifier: Apache-2.0

/**
 * Zero-footprint invariant — codifies the runtime contract that a disabled
 * module contributes nothing to the platform.
 *
 * The module-loader static analysis guards imports and filesystem layout,
 * but this file exercises the actual Hono app + OpenAPI builder with an
 * empty module list to prove that:
 *
 *   1. Module routes return 404 (not mounted)
 *   2. Module space-scoped prefixes don't trigger requireSpaceContext
 *   3. OpenAPI spec has no module paths / components / tags
 *   4. The default buildAppConfig() has no module feature flags set
 *
 * A failure in 1-4 means a module has LEAKED INTO core. Do not mask it by
 * adding special cases here — fix the leak.
 *
 * And the mirror of all four, which fails for the opposite reason:
 *
 *   5. Custom space roles work with no module mounted (RBAC spec §9)
 *
 * A failure there means core has come to DEPEND ON a module — a licence gate
 * put back over routes the Apache-2.0 platform owns. Fix the gate, not the
 * test.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { buildOpenApiSpec } from "../../../src/openapi/index.ts";
import { buildAppConfig } from "../../../src/lib/app-config.ts";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import {
  orgPermissions,
  presetPermissions,
  getApiKeyAllowedScopes,
} from "../../../src/lib/permissions.ts";
import {
  getModuleEndUserAllowedScopes,
  setModulePermissionsProvider,
} from "@appstrate/core/permissions";

// Fresh app, no modules mounted (bypasses the preload-discovered registry).
const app = getTestApp({ modules: [] });

describe("zero-footprint invariant (no modules loaded)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "zfp" });
  });

  describe("module routes", () => {
    it("GET /api/webhooks → 404", async () => {
      const res = await app.request("/api/webhooks", { headers: authHeaders(ctx) });
      expect(res.status).toBe(404);
    });

    it("POST /api/webhooks → 404", async () => {
      const res = await app.request("/api/webhooks", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/hook", events: ["run.success"] }),
      });
      expect(res.status).toBe(404);
    });

    it("GET /api/webhooks/wh_123 → 404", async () => {
      const res = await app.request("/api/webhooks/wh_123", { headers: authHeaders(ctx) });
      expect(res.status).toBe(404);
    });

    it("GET /api/billing → 404", async () => {
      const res = await app.request("/api/billing", { headers: authHeaders(ctx) });
      expect(res.status).toBe(404);
    });
  });

  describe("OpenAPI spec", () => {
    const spec = buildOpenApiSpec();

    it("has no webhook paths", () => {
      const webhookPaths = Object.keys(spec.paths).filter((p) => p.includes("webhook"));
      expect(webhookPaths).toEqual([]);
    });

    it("has no webhook component schemas", () => {
      const schemaNames = Object.keys(spec.components.schemas).filter((n) =>
        n.toLowerCase().includes("webhook"),
      );
      expect(schemaNames).toEqual([]);
    });

    it("has no webhook tag", () => {
      const webhookTag = spec.tags.find((t) => t.name.toLowerCase().includes("webhook"));
      expect(webhookTag).toBeUndefined();
    });

    it("has no billing paths", () => {
      const billingPaths = Object.keys(spec.paths).filter((p) => p.startsWith("/api/billing"));
      expect(billingPaths).toEqual([]);
    });

    it("has no Ee* component schemas", () => {
      const schemaNames = Object.keys(spec.components.schemas).filter((n) => n.startsWith("Ee"));
      expect(schemaNames).toEqual([]);
    });
  });

  describe("app config features", () => {
    it("base config has no webhooks flag — only modules contribute it", () => {
      // buildAppConfig() is core-only; applyModuleFeatures() is what merges
      // module contributions later. The raw base must not mention any
      // module-owned flag.
      const cfg = buildAppConfig();
      expect(cfg.features.webhooks).toBeUndefined();
    });

    it("base config has no billing flag — only @appstrate/module-ee contributes it", () => {
      const cfg = buildAppConfig();
      expect(cfg.features.billing).toBeUndefined();
    });
  });

  /**
   * The OTHER direction of the same invariant: what a module must NOT be
   * needed for.
   *
   * `/api/roles` was licensed by `@appstrate/module-ee`'s `custom_roles`
   * feature flag until custom space roles became open-source (RBAC spec §9).
   * Every assertion below answered `403 feature_unavailable` under that gate,
   * and this app mounts NO module at all — so green here is the whole claim
   * "a deployment running nothing but the Apache-2.0 platform can define,
   * edit, grant and preview a bundle". A licence gate put back over any of the
   * four turns this red.
   */
  describe("custom space roles need no module", () => {
    const orgReq = (method: string, path: string, body?: unknown, as: TestContext = ctx) =>
      app.request(path, {
        method,
        headers: {
          ...authHeaders(as),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    it("defines, edits, grants and previews a bundle with zero modules mounted", async () => {
      const created = await orgReq("POST", "/api/roles", {
        key: "support",
        name: "Support",
        permissions: ["agents:read"],
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const role = (await created.json()) as { id: string };

      expect((await orgReq("PATCH", `/api/roles/${role.id}`, { name: "Support L2" })).status).toBe(
        200,
      );

      // Granting was the second half of what the flag licensed — defining a
      // bundle nobody may be given would have been a hollow win.
      const target = await memberContext(ctx, "guest");
      const granted = await orgReq("POST", `/api/spaces/${ctx.defaultSpaceId}/members`, {
        userId: target.user.id,
        custom_role_id: role.id,
      });
      expect(granted.status, await granted.clone().text()).toBe(201);

      // And previewing one: the persona refusal used to read the same flag.
      const preview = await app.request("/api/spaces", {
        headers: authHeaders(ctx, {
          "X-View-As": `org_role=member; space=${ctx.defaultSpaceId}; role=custom:${role.id}`,
        }),
      });
      expect(preview.status, await preview.clone().text()).toBe(200);
      expect(preview.headers.get("X-View-As-Active")).toBe("1");

      // The control, green on BOTH sides of this change: DELETE was never
      // gated, so a red here says the harness stopped reaching the router —
      // not that a licence came back.
      const refused = await orgReq("DELETE", `/api/roles/${role.id}`);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "role_in_use", member_count: 1 });
    });

    it("still refuses an org member, who holds no `roles:write`", async () => {
      // The half that must stay red. "Open-source" is not "everyone": the
      // `roles:*` permissions are now the WHOLE gate, so they have to hold.
      const member = await memberContext(ctx, "member");
      const refused = await orgReq(
        "POST",
        "/api/roles",
        { key: "sneak", name: "Sneak", permissions: ["agents:read"] },
        member,
      );
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "forbidden" });
    });
  });

  describe("permission catalog (runtime)", () => {
    // `getTestApp({ modules: [] })` above registered an empty RBAC snapshot
    // at file-load time — but other integration tests running in the same
    // `bun test` process call `getTestApp()` with the default discovered
    // modules (webhooks + oidc) and overwrite the provider globally. Reset
    // to the EMPTY_SNAPSHOT default inside this describe so we actually
    // exercise the "no modules loaded" state the route tests above rely on.
    beforeEach(() => {
      setModulePermissionsProvider(null);
    });

    const moduleOwnedScopes = [
      "webhooks:read",
      "webhooks:write",
      "webhooks:delete",
      "oauth-clients:read",
      "oauth-clients:write",
      "oauth-clients:delete",
      "billing:read",
      "billing:manage",
    ];

    it("role and preset permission sets contain no module-owned scopes", () => {
      for (const role of ["owner", "admin", "member", "guest"] as const) {
        const perms: ReadonlySet<string> = orgPermissions(role);
        for (const scope of moduleOwnedScopes) {
          expect(perms.has(scope)).toBe(false);
        }
      }
      for (const preset of SPACE_ROLE_PRESETS) {
        const perms: ReadonlySet<string> = presetPermissions(preset);
        for (const scope of moduleOwnedScopes) {
          expect(perms.has(scope)).toBe(false);
        }
      }
    });

    it("API-key allowlist contains no module-owned scopes", () => {
      const allowed = getApiKeyAllowedScopes();
      for (const scope of moduleOwnedScopes) {
        expect(allowed.has(scope)).toBe(false);
      }
    });

    it("end-user OIDC allowlist is empty when no module opts in", () => {
      expect(getModuleEndUserAllowedScopes().size).toBe(0);
    });
  });
});
