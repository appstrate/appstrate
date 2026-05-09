// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, orgOnlyHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";

const app = getTestApp();

describe("Application Provider Credentials", () => {
  let ctx: TestContext;
  const providerId = "@testorg/test-provider";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });

    // Seed a provider package
    await seedPackage({
      id: providerId,
      orgId: ctx.orgId,
      type: "provider",
      draftManifest: {
        name: providerId,
        type: "provider",
        version: "1.0.0",
        definition: { authMode: "oauth2" },
      },
    });
  });

  describe("PUT /api/applications/:applicationId/providers/:scope/:name/credentials", () => {
    it("sets app-level credentials", async () => {
      const res = await app.request(
        `/api/applications/${ctx.defaultAppId}/providers/@testorg/test-provider/credentials`,
        {
          method: "PUT",
          headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({
            credentials: { clientId: "app-client-id", clientSecret: "app-client-secret" },
          }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { configured: boolean };
      expect(body.configured).toBe(true);
    });

    it("sets app-level enabled=false to disable provider for app", async () => {
      const res = await app.request(
        `/api/applications/${ctx.defaultAppId}/providers/@testorg/test-provider/credentials`,
        {
          method: "PUT",
          headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      expect(res.status).toBe(200);

      // Verify the override is listed
      const listRes = await app.request(`/api/applications/${ctx.defaultAppId}/providers`, {
        headers: orgOnlyHeaders(ctx),
      });
      const list = (await listRes.json()) as {
        data: Array<{ providerId: string; appEnabled: boolean }>;
      };
      const override = list.data.find((o) => o.providerId === providerId);
      expect(override).toBeDefined();
      expect(override!.appEnabled).toBe(false);
    });

    it("returns 404 for non-existent provider", async () => {
      const res = await app.request(
        `/api/applications/${ctx.defaultAppId}/providers/@testorg/nonexistent/credentials`,
        {
          method: "PUT",
          headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({
            credentials: { clientId: "x", clientSecret: "y" },
          }),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/applications/:applicationId/providers/:scope/:name/credentials", () => {
    it("removes app-level override", async () => {
      // First set an override
      await app.request(
        `/api/applications/${ctx.defaultAppId}/providers/@testorg/test-provider/credentials`,
        {
          method: "PUT",
          headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({
            credentials: { clientId: "x", clientSecret: "y" },
          }),
        },
      );

      // Delete the override
      const res = await app.request(
        `/api/applications/${ctx.defaultAppId}/providers/@testorg/test-provider/credentials`,
        {
          method: "DELETE",
          headers: orgOnlyHeaders(ctx),
        },
      );
      expect(res.status).toBe(204);

      // Verify it's gone from the list
      const listRes = await app.request(`/api/applications/${ctx.defaultAppId}/providers`, {
        headers: orgOnlyHeaders(ctx),
      });
      const list = (await listRes.json()) as { data: Array<{ providerId: string }> };
      const override = list.data.find((o) => o.providerId === providerId);
      expect(override).toBeUndefined();
    });

    it("returns 204 even when no override exists (idempotent)", async () => {
      const res = await app.request(
        `/api/applications/${ctx.defaultAppId}/providers/@testorg/test-provider/credentials`,
        {
          method: "DELETE",
          headers: orgOnlyHeaders(ctx),
        },
      );
      expect(res.status).toBe(204);
    });
  });

  describe("GET /api/applications/:applicationId/providers", () => {
    it("returns empty list when no overrides exist", async () => {
      const res = await app.request(`/api/applications/${ctx.defaultAppId}/providers`, {
        headers: orgOnlyHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(0);
    });

    it("lists overrides after setting credentials", async () => {
      // Set credentials
      await app.request(
        `/api/applications/${ctx.defaultAppId}/providers/@testorg/test-provider/credentials`,
        {
          method: "PUT",
          headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({
            credentials: { clientId: "x", clientSecret: "y" },
            enabled: true,
          }),
        },
      );

      const res = await app.request(`/api/applications/${ctx.defaultAppId}/providers`, {
        headers: orgOnlyHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ providerId: string; hasAppCredentials: boolean; appEnabled: boolean }>;
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.providerId).toBe(providerId);
      expect(body.data[0]!.hasAppCredentials).toBe(true);
      expect(body.data[0]!.appEnabled).toBe(true);
    });

    it("shows hasAppCredentials=false when only enabled is set", async () => {
      // Disable provider without setting credentials
      await app.request(
        `/api/applications/${ctx.defaultAppId}/providers/@testorg/test-provider/credentials`,
        {
          method: "PUT",
          headers: { ...orgOnlyHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );

      const res = await app.request(`/api/applications/${ctx.defaultAppId}/providers`, {
        headers: orgOnlyHeaders(ctx),
      });
      const body = (await res.json()) as {
        data: Array<{ hasAppCredentials: boolean; appEnabled: boolean }>;
      };
      expect(body.data[0]!.hasAppCredentials).toBe(false);
      expect(body.data[0]!.appEnabled).toBe(false);
    });
  });
});
