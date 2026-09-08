// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it, beforeEach } from "bun:test";
import { truncateEeTables } from "../../helpers/db.ts";
import { seedBillingAccount, seedBillingManager } from "../../helpers/seed.ts";
import { seedOrgMembers } from "../../helpers/org-queries.ts";
import { getTestApp } from "../../helpers/app.ts";
import {
  isBillingManager,
  listBillingManagers,
  replaceBillingManagers,
} from "../../../src/billing/managers.ts";
import {
  resolvePrincipalPermissions,
  setPrincipalPermissionsProviders,
} from "@appstrate/core/principal-permissions";
import eeModule from "../../../src/index.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();

/**
 * Billing managers — org users who hold `billing:*` without an admin role
 * (RBAC spec §10). The route half; the resolver half is asserted directly
 * because the platform, not this app, is what calls it.
 */
describe("billing managers", () => {
  const orgId = "00000000-0000-4000-a000-0000000000b0";
  const app = getTestApp();

  function headers(overrides?: Record<string, string>) {
    return {
      "X-Test-Org-Id": orgId,
      "X-Test-Org-Role": "owner",
      "X-Test-User-Id": "user-owner",
      "content-type": "application/json",
      ...overrides,
    };
  }

  beforeEach(async () => {
    await truncateEeTables();
    await seedBillingAccount({ orgId });
    seedOrgMembers(orgId, [
      { userId: "user-owner", email: "owner@example.com", role: "owner" },
      { userId: "user-admin", email: "admin@example.com", role: "admin" },
      { userId: "user-finance", email: "finance@example.com", role: "member" },
      { userId: "user-dev", email: "dev@example.com", role: "member" },
      { userId: "user-guest", email: "guest@example.com", role: "guest" },
    ]);
  });

  describe("GET /api/billing/managers", () => {
    it("lists the org's managers", async () => {
      await seedBillingManager({ orgId, userId: "user-finance", addedBy: "user-owner" });

      const res = await app.request("/api/billing/managers", { headers: headers() });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { managers: Array<Record<string, unknown>> };
      expect(body.managers).toHaveLength(1);
      expect(body.managers[0]!.user_id).toBe("user-finance");
      expect(body.managers[0]!.added_by).toBe("user-owner");
      expect(typeof body.managers[0]!.created_at).toBe("string");
    });

    it("refuses a plain member", async () => {
      const res = await app.request("/api/billing/managers", {
        headers: headers({ "X-Test-Org-Role": "member", "X-Test-User-Id": "user-dev" }),
      });
      expect(res.status).toBe(403);
    });

    it("admits a member who IS a billing manager", async () => {
      // The grant reaches the guard through `principalPermissions`, which the
      // platform unions into the same permission set — the header stands in for
      // it. Discriminating against the case above: same role, different grants.
      const res = await app.request("/api/billing/managers", {
        headers: headers({
          "X-Test-Org-Role": "member",
          "X-Test-User-Id": "user-finance",
          "X-Test-Principal-Grants": "billing:read,billing:manage",
        }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("PUT /api/billing/managers", () => {
    it("replaces the set and attributes the grant to the caller", async () => {
      const res = await app.request("/api/billing/managers", {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ user_ids: ["user-finance", "user-dev"] }),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { managers: Array<{ user_id: string }> };
      expect(body.managers.map((m) => m.user_id).sort()).toEqual(["user-dev", "user-finance"]);
      expect(await isBillingManager(orgId, "user-finance")).toBe(true);
      expect((await listBillingManagers(orgId))[0]!.addedBy).toBe("user-owner");
    });

    it("removes the ids the new set omits", async () => {
      await seedBillingManager({ orgId, userId: "user-finance" });
      await seedBillingManager({ orgId, userId: "user-dev" });

      const res = await app.request("/api/billing/managers", {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ user_ids: ["user-dev"] }),
      });
      expect(res.status).toBe(200);
      expect(await isBillingManager(orgId, "user-finance")).toBe(false);
      expect(await isBillingManager(orgId, "user-dev")).toBe(true);
    });

    it("keeps the original grant of a manager the new set retains", async () => {
      await seedBillingManager({ orgId, userId: "user-finance", addedBy: "user-first" });

      await app.request("/api/billing/managers", {
        method: "PUT",
        headers: headers({ "X-Test-User-Id": "user-admin" }),
        body: JSON.stringify({ user_ids: ["user-finance"] }),
      });

      expect((await listBillingManagers(orgId))[0]!.addedBy).toBe("user-first");
    });

    it("clears the set on an empty array", async () => {
      await seedBillingManager({ orgId, userId: "user-finance" });

      const res = await app.request("/api/billing/managers", {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ user_ids: [] }),
      });
      expect(res.status).toBe(200);
      expect(await listBillingManagers(orgId)).toEqual([]);
    });

    it("refuses a user id that is not a member of the org", async () => {
      const res = await app.request("/api/billing/managers", {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ user_ids: ["user-finance", "user-elsewhere"] }),
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("user-elsewhere");
      // The whole write is refused, not the offending half of it.
      expect(await isBillingManager(orgId, "user-finance")).toBe(false);
    });

    it("refuses an owner or admin — they already manage billing by role", async () => {
      const res = await app.request("/api/billing/managers", {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ user_ids: ["user-admin"] }),
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { detail: string };
      expect(body.detail).toContain("user-admin");
      expect(body.detail).toContain("organization role");
    });

    it("rejects a malformed body", async () => {
      const res = await app.request("/api/billing/managers", {
        method: "PUT",
        headers: headers(),
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("rejects a body without user_ids", async () => {
      const res = await app.request("/api/billing/managers", {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("refuses a plain member", async () => {
      const res = await app.request("/api/billing/managers", {
        method: "PUT",
        headers: headers({ "X-Test-Org-Role": "member", "X-Test-User-Id": "user-dev" }),
        body: JSON.stringify({ user_ids: [] }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("principalPermissions resolver", () => {
    it("answers only for the (org, user) pair that holds a row", async () => {
      await seedBillingManager({ orgId, userId: "user-finance" });

      expect(await isBillingManager(orgId, "user-finance")).toBe(true);
      expect(await isBillingManager(orgId, "user-dev")).toBe(false);
      expect(await isBillingManager("00000000-0000-4000-a000-0000000000b1", "user-finance")).toBe(
        false,
      );
    });

    /**
     * Through core's own registry and cache, which is what the platform runs:
     * the module declares the surface, the platform caches the answer for 10s,
     * and only EE's own `invalidatePrincipalPermissions` call can make a
     * write visible before the TTL. A write that forgot to invalidate passes
     * every test above and fails this one.
     */
    it("grants both strings through core, and a write is visible immediately", async () => {
      setPrincipalPermissionsProviders([{ moduleId: "EE", ...eeModule.principalPermissions! }]);
      try {
        const ctx = { orgId, userId: "user-finance" };
        expect([...(await resolvePrincipalPermissions(ctx))]).toEqual([]);

        await replaceBillingManagers(orgId, ["user-finance"], "user-owner");
        expect([...(await resolvePrincipalPermissions(ctx))].sort()).toEqual([
          "billing:manage",
          "billing:read",
        ]);

        await replaceBillingManagers(orgId, [], "user-owner");
        expect([...(await resolvePrincipalPermissions(ctx))]).toEqual([]);
      } finally {
        setPrincipalPermissionsProviders(null);
      }
    });
  });
});
