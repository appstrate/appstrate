// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  seedApiKey,
  seedSpace,
  seedPackage,
  seedInstalledPackage,
  seedOrgModel,
  seedOrgModelProviderOAuth,
} from "../../helpers/seed.ts";
import { assertDbMissing } from "../../helpers/assertions.ts";
import { spaces, spacePackages, auditEvents } from "@appstrate/db/schema";

const app = getTestApp();

describe("Spaces API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  describe("GET /api/spaces", () => {
    it("lists spaces including the default space from createTestContext", async () => {
      const res = await app.request("/api/spaces", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.object).toBe("list");
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(1);

      const defaultSpace = body.data.find((a: { id: string }) => a.id === ctx.defaultSpaceId);
      expect(defaultSpace).toBeDefined();
      expect(defaultSpace.object).toBe("space");
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/spaces");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/spaces", () => {
    it("creates a space", async () => {
      const res = await app.request("/api/spaces", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "My New Space" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.object).toBe("space");
      expect(body.name).toBe("My New Space");
      expect(body.id).toBeDefined();
    });

    // The audit row's `action` and `resource_type` are PERSISTED vocabulary —
    // rows written before the rename still say `application.created` and the
    // operator rewrite script matches on these exact strings. Nothing else in
    // the core suite pins them, so a silent drift here would only surface as an
    // unrewritable audit trail long after the deploy.
    it("records the audit event under the `space` vocabulary", async () => {
      const res = await app.request("/api/spaces", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Audited" }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string };

      const [row] = await db
        .select({
          action: auditEvents.action,
          resourceType: auditEvents.resourceType,
          resourceId: auditEvents.resourceId,
        })
        .from(auditEvents)
        .where(eq(auditEvents.resourceId, created.id));
      expect(row).toEqual({
        action: "space.created",
        resourceType: "space",
        resourceId: created.id,
      });
    });
  });

  describe("GET /api/spaces/:id", () => {
    it("returns a space by ID", async () => {
      const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.object).toBe("space");
      expect(body.id).toBe(ctx.defaultSpaceId);
    });
  });

  describe("PATCH /api/spaces/:id", () => {
    it("updates space name", async () => {
      // Create a non-default space to update
      const createRes = await app.request("/api/spaces", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Original Name" }),
      });
      const created = (await createRes.json()) as any;

      const res = await app.request(`/api/spaces/${created.id}`, {
        method: "PATCH",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Name" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.object).toBe("space");
      expect(body.name).toBe("Updated Name");
    });
  });

  describe("DELETE /api/spaces/:id", () => {
    it("deletes a space and returns 204", async () => {
      // Create a non-default space to delete
      const createRes = await app.request("/api/spaces", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "To Delete" }),
      });
      const created = (await createRes.json()) as any;

      const res = await app.request(`/api/spaces/${created.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(204);

      // Verify it is gone from the list
      const listRes = await app.request("/api/spaces", {
        headers: authHeaders(ctx),
      });
      const listBody = (await listRes.json()) as any;
      const found = listBody.data.find((a: { id: string }) => a.id === created.id);
      expect(found).toBeUndefined();
    });
  });

  // Issue #172 (extension) — API keys are space-scoped, but the
  // spaces router only filtered by orgId. A key bound to Space A could
  // therefore enumerate, read, mutate, and delete every Space B in the same
  // org. These tests pin the cross-space surface.
  describe("API key space scope (issue #172 extension)", () => {
    async function setupTwoSpaceKey() {
      const sharedCtx = await createTestContext({ orgSlug: "spacescope-172" });
      const otherSpace = await seedSpace({
        orgId: sharedCtx.orgId,
        name: "Other Space",
      });
      const apiKey = await seedApiKey({
        orgId: sharedCtx.orgId,
        spaceId: sharedCtx.defaultSpaceId,
        createdBy: sharedCtx.user.id,
        scopes: ["spaces:read", "spaces:write", "spaces:delete", "integrations:read"],
      });
      return {
        ctx: sharedCtx,
        otherSpaceId: otherSpace.id,
        bearer: { Authorization: `Bearer ${apiKey.rawKey}` },
      };
    }

    it("GET /api/spaces returns only the key's space", async () => {
      const { ctx, otherSpaceId, bearer } = await setupTwoSpaceKey();
      const res = await app.request("/api/spaces", { headers: bearer });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { id: string }[] };
      const ids = body.data.map((a) => a.id);
      expect(ids).toContain(ctx.defaultSpaceId);
      expect(ids).not.toContain(otherSpaceId);
      expect(body.data).toHaveLength(1);
    });

    it("GET /api/spaces/:otherSpaceId returns 403", async () => {
      const { otherSpaceId, bearer } = await setupTwoSpaceKey();
      const res = await app.request(`/api/spaces/${otherSpaceId}`, { headers: bearer });
      expect(res.status).toBe(403);
    });

    it("PATCH /api/spaces/:otherSpaceId returns 403 and does not mutate", async () => {
      const { otherSpaceId, bearer } = await setupTwoSpaceKey();
      const res = await app.request(`/api/spaces/${otherSpaceId}`, {
        method: "PATCH",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "PWNED" }),
      });
      expect(res.status).toBe(403);
      const [row] = await db
        .select({ name: spaces.name })
        .from(spaces)
        .where(eq(spaces.id, otherSpaceId));
      expect(row?.name).not.toBe("PWNED");
    });

    it("DELETE /api/spaces/:otherSpaceId returns 403 and the space survives", async () => {
      const { otherSpaceId, bearer } = await setupTwoSpaceKey();
      const res = await app.request(`/api/spaces/${otherSpaceId}`, {
        method: "DELETE",
        headers: bearer,
      });
      expect(res.status).toBe(403);
      const rows = await db
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.id, otherSpaceId));
      expect(rows).toHaveLength(1);
    });

    it("POST /api/spaces returns 403 — API keys cannot create spaces", async () => {
      const { bearer } = await setupTwoSpaceKey();
      const res = await app.request("/api/spaces", {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Pwn Space" }),
      });
      expect(res.status).toBe(403);
    });

    it("POST /api/spaces/:otherSpaceId/packages returns 403", async () => {
      const { otherSpaceId, bearer } = await setupTwoSpaceKey();
      const res = await app.request(`/api/spaces/${otherSpaceId}/packages`, {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "@x/y" }),
      });
      expect(res.status).toBe(403);
    });

    it("DELETE /api/spaces/:keySpaceId is allowed (own scope)", async () => {
      const { ctx, bearer } = await setupTwoSpaceKey();
      // Just confirm the guard does not block — actual delete may 4xx for
      // default-space constraints, but it must not be 403 from the guard.
      const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}`, {
        method: "DELETE",
        headers: bearer,
      });
      expect(res.status).not.toBe(403);
    });
  });

  // ── CRIT-05 — PUT on a not-installed package must NOT implicitly install ──
  //
  // `updateInstalledPackage` used to upsert unconditionally, so a
  // `PUT /spaces/:id/packages/:packageId` for a package with no
  // `space_packages` row silently CREATED the association (an implicit
  // install bypassing the POST install path). The public route now passes
  // `requireInstalled: true`: no pre-existing row → 404, no row created.
  describe("PUT /api/spaces/:id/packages/:packageId requires a prior install (CRIT-05)", () => {
    function putPackage(packageId: string, body: Record<string, unknown> = { enabled: false }) {
      return app.request(`/api/spaces/${ctx.defaultSpaceId}/packages/${packageId}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    function installedRowWhere(packageId: string) {
      return and(
        eq(spacePackages.spaceId, ctx.defaultSpaceId),
        eq(spacePackages.packageId, packageId),
      )!;
    }

    it("404s for an org-owned package that is NOT installed, and creates no association row", async () => {
      // The package exists and is visible to the org — only the install is missing.
      await seedPackage({ id: "@testorg/not-installed", orgId: ctx.orgId });

      const res = await putPackage("@testorg/not-installed");

      expect(res.status).toBe(404);
      // The regression: pre-fix this PUT upserted the row (implicit install).
      await assertDbMissing(spacePackages, installedRowWhere("@testorg/not-installed"));
    });

    it("succeeds on the exact same PUT once the package IS installed (feature intact)", async () => {
      await seedPackage({ id: "@testorg/installed-pkg", orgId: ctx.orgId });
      await seedInstalledPackage(ctx.defaultSpaceId, "@testorg/installed-pkg");

      const res = await putPackage("@testorg/installed-pkg", { enabled: false });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { object: string };
      expect(body.object).toBe("space_package");
      const [row] = await db
        .select({ enabled: spacePackages.enabled })
        .from(spacePackages)
        .where(installedRowWhere("@testorg/installed-pkg"));
      expect(row?.enabled).toBe(false);
    });

    // The agent's stored input values have ONE write path
    // (`PUT /api/agents/{scope}/{name}/input-settings`, which validates them
    // against the manifest input schema and refuses an unsatisfiable locked
    // required field). This generic route must not be a second, unvalidated one.
    it("ignores an `input_settings` key in the body — it is not a write path for stored input values", async () => {
      await seedPackage({ id: "@testorg/no-input-settings-write", orgId: ctx.orgId });
      await seedInstalledPackage(ctx.defaultSpaceId, "@testorg/no-input-settings-write");

      const res = await putPackage("@testorg/no-input-settings-write", {
        input_settings: { values: { hello: "world" }, locked: [] },
      });

      expect(res.status).toBe(200);
      const [row] = await db
        .select({ inputSettings: spacePackages.inputSettings })
        .from(spacePackages)
        .where(installedRowWhere("@testorg/no-input-settings-write"));
      expect(row?.inputSettings).toEqual({ values: {}, locked: [] });
    });

    it("rejects unsupported generation settings instead of persisting them", async () => {
      const packageId = "@testorg/generation-agent";
      await seedPackage({ id: packageId, orgId: ctx.orgId });
      await seedInstalledPackage(ctx.defaultSpaceId, packageId);
      const credential = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: "codex",
      });
      const model = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: credential.id,
        modelId: "gpt-5.6-luna",
      });

      const res = await putPackage(packageId, {
        modelId: model.id,
        generationConfig: { temperature: 0.4 },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "invalid_request",
        param: "generationConfig",
      });
      const [row] = await db
        .select({ modelId: spacePackages.modelId })
        .from(spacePackages)
        .where(installedRowWhere(packageId));
      expect(row?.modelId).toBeNull();
    });

    it("reconciles persisted generation defaults when the model changes", async () => {
      const packageId = "@testorg/reconciled-agent";
      await seedPackage({ id: packageId, orgId: ctx.orgId });
      await seedInstalledPackage(ctx.defaultSpaceId, packageId, {
        generationConfig: { temperature: 0.7 },
      });
      const credential = await seedOrgModelProviderOAuth({
        orgId: ctx.orgId,
        providerId: "codex",
      });
      const model = await seedOrgModel({
        orgId: ctx.orgId,
        credentialId: credential.id,
        modelId: "gpt-5.6-luna",
      });

      const res = await putPackage(packageId, { modelId: model.id });

      expect(res.status).toBe(200);
      const [row] = await db
        .select({ generation: spacePackages.generationConfig })
        .from(spacePackages)
        .where(installedRowWhere(packageId));
      expect(row?.generation).toEqual({});
    });

    it("404s for a package owned by ANOTHER org, and creates no association row", async () => {
      const foreignCtx = await createTestContext({ orgSlug: "foreignorg" });
      await seedPackage({ id: "@foreignorg/theirs", orgId: foreignCtx.orgId });

      const res = await putPackage("@foreignorg/theirs");

      expect(res.status).toBe(404);
      await assertDbMissing(spacePackages, installedRowWhere("@foreignorg/theirs"));
    });
  });

  // ── CRIT-05 — a historical stray association must not leak on the list ──
  //
  // The old unconditional-upsert PUT could create an `space_packages`
  // row pointing at ANOTHER org's package. Blocking new creations is not
  // enough: `listInstalledPackages` must also refuse to resolve such a row,
  // or the foreign package's draft_manifest leaks through
  // `GET /api/spaces/:id/packages`.
  describe("GET /api/spaces/:id/packages excludes stray cross-org associations (CRIT-05)", () => {
    it("omits a foreign-org package attached by a corrupted association row", async () => {
      const foreignCtx = await createTestContext({ orgSlug: "foreignorg" });
      await seedPackage({ id: "@foreignorg/leaky", orgId: foreignCtx.orgId });
      await seedPackage({ id: "@testorg/mine", orgId: ctx.orgId });
      // Insert both associations directly in DB — the stray one simulates a
      // row created by the pre-fix vulnerable PUT.
      await seedInstalledPackage(ctx.defaultSpaceId, "@foreignorg/leaky");
      await seedInstalledPackage(ctx.defaultSpaceId, "@testorg/mine");

      const res = await app.request(`/api/spaces/${ctx.defaultSpaceId}/packages`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ packageId: string }> };
      const ids = body.data.map((row) => row.packageId);
      expect(ids).toContain("@testorg/mine");
      expect(ids).not.toContain("@foreignorg/leaky");
    });
  });
});
