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
 *   2. Module app-scoped prefixes don't trigger requireAppContext
 *   3. OpenAPI spec has no module paths / components / tags
 *   4. The default buildAppConfig() has no module feature flags set
 *
 * If this test fails, a module has leaked into core. Do not mask it by
 * adding special cases here — fix the leak.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { buildOpenApiSpec } from "../../../src/openapi/index.ts";
import { buildAppConfig } from "../../../src/lib/app-config.ts";
import {
  resolvePermissions,
  getApiKeyAllowedScopes,
  getModuleEndUserAllowedScopes,
  setModulePermissionsProvider,
} from "../../../src/lib/permissions.ts";

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
  });

  describe("app config features", () => {
    it("base config has no webhooks flag — only modules contribute it", () => {
      // buildAppConfig() is core-only; applyModuleFeatures() is what merges
      // module contributions later. The raw base must not mention any
      // module-owned flag.
      const cfg = buildAppConfig();
      expect(cfg.features.webhooks).toBeUndefined();
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
    ];

    it("role permission sets contain no module-owned scopes", () => {
      for (const role of ["owner", "admin", "member", "viewer"] as const) {
        const perms: ReadonlySet<string> = resolvePermissions(role);
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
