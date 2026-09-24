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
  seedSpacePackage,
  seedPackageShare,
  seedOrgModel,
  seedRun,
  seedOrgModelProviderOAuth,
} from "../../helpers/seed.ts";
import { assertDbHas, assertDbMissing, expectProblem, getDbRow } from "../../helpers/assertions.ts";
import { spaces, spacePackages, auditEvents, packages, runs } from "@appstrate/db/schema";
import { insertShadowPackage } from "../../../src/services/inline-run.ts";
import type { AgentManifest } from "../../../src/types/index.ts";

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

    // The audit row's `action` and `resource_type` are PERSISTED vocabulary,
    // and `audit_events` is append-only: `scripts/migration/0003` deliberately
    // does NOT rewrite these columns (see its `WHAT THIS DELIBERATELY DOES NOT
    // REWRITE` section — rewriting them would falsify the history the table
    // exists to keep). The trail is therefore permanently split at the deploy:
    // `application.created` before it, `space.created` after it, by design.
    //
    // That split is exactly why these two strings have to be pinned HERE. They
    // are the vocabulary NEW rows are written with, and nothing else in the
    // core suite asserts on them. A silent drift would move the boundary to
    // some unknown later commit and leave a third spelling in the trail, with
    // no rewrite available to reconcile it and nothing that could detect when
    // it started.
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

    // `packages.home_space_id` is `ON DELETE RESTRICT`: a homed package cannot
    // follow its space out, and nothing may re-home it behind the caller's back
    // (RBAC spec §6.9). The delete therefore has to refuse, name the packages,
    // and leave the space standing.
    describe("a space that homes packages", () => {
      let doomed: string;

      beforeEach(async () => {
        doomed = (await seedSpace({ orgId: ctx.orgId, name: "Homes Things" })).id;
      });

      const del = () =>
        app.request(`/api/spaces/${doomed}`, { method: "DELETE", headers: authHeaders(ctx) });

      it("refuses with 409 and names them", async () => {
        await seedPackage({ id: "@testorg/homed", orgId: ctx.orgId, homeSpaceId: doomed });

        const body = await expectProblem(await del(), 409, { code: "space_homes_packages" });
        expect(body.detail).toContain("@testorg/homed");
        await assertDbHas(spaces, eq(spaces.id, doomed));
      });

      it("succeeds once the package has moved home", async () => {
        await seedPackage({ id: "@testorg/homed", orgId: ctx.orgId, homeSpaceId: doomed });
        await seedSpacePackage(doomed, "@testorg/homed");

        const moved = await app.request("/api/packages/@testorg/homed/home", {
          method: "PUT",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({ home_space_id: ctx.defaultSpaceId }),
        });
        expect(moved.status, await moved.clone().text()).toBe(200);

        expect((await del()).status).toBe(204);
        await assertDbMissing(spaces, eq(spaces.id, doomed));
      });

      it("an inline run's shadow row carries no home", async () => {
        // A shadow package is minted by every inline run and hard-deleted only
        // by the compaction sweeper. Homing it would make one run enough to
        // wedge its space forever, so shadows carry no home at all — which is
        // what makes the delete below succeed, not a filter on the 409 query.
        const shadowId = await insertShadowPackage({
          orgId: ctx.orgId,
          createdBy: ctx.user.id,
          manifest: {
            name: "@inline/shadow",
            version: "0.1.0",
            type: "agent",
            description: "d",
          } as unknown as AgentManifest,
          prompt: "hi",
        });
        await seedSpacePackage(doomed, shadowId);

        expect((await getDbRow(packages, eq(packages.id, shadowId))).homeSpaceId).toBeNull();
        expect((await del()).status).toBe(204);
        await assertDbMissing(spaces, eq(spaces.id, doomed));
      });
    });

    // The delete cascade-drops `runs`/`run_logs`, so performing it while a run
    // is executing rips the rows out from under a live container — the same
    // rule organization deletion has, from the same predicate
    // (`countInProgressRuns`).
    describe("a space with runs in progress", () => {
      let doomed: string;

      const del = () =>
        app.request(`/api/spaces/${doomed}`, { method: "DELETE", headers: authHeaders(ctx) });

      beforeEach(async () => {
        doomed = (await seedSpace({ orgId: ctx.orgId, name: "Busy" })).id;
        await seedPackage({
          id: "@testorg/busy",
          orgId: ctx.orgId,
          type: "agent",
          homeSpaceId: ctx.defaultSpaceId,
        });
      });

      for (const status of ["pending", "running"] as const) {
        it(`refuses with 409 while a run is ${status}`, async () => {
          await seedRun({
            orgId: ctx.orgId,
            spaceId: doomed,
            packageId: "@testorg/busy",
            status,
          });
          await expectProblem(await del(), 409, { code: "space_has_active_runs" });
          await assertDbHas(spaces, eq(spaces.id, doomed));
        });
      }

      it("succeeds once the run has settled", async () => {
        const run = await seedRun({
          orgId: ctx.orgId,
          spaceId: doomed,
          packageId: "@testorg/busy",
          status: "running",
        });
        await expectProblem(await del(), 409, { code: "space_has_active_runs" });
        await db.update(runs).set({ status: "success" }).where(eq(runs.id, run.id));
        expect((await del()).status).toBe(204);
        await assertDbMissing(spaces, eq(spaces.id, doomed));
      });
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

  // ── CRIT-05 — PUT on an unplaced package must NOT implicitly place it ──
  //
  // `updateSpacePackage` upserts for its internal callers, so a
  // `PUT /spaces/:id/packages/:packageId` for a package with no
  // `space_packages` row would silently CREATE the placement (an implicit
  // activation bypassing the POST door). The public route passes
  // `requirePlacement: true`: no pre-existing row → 404, no row created.
  describe("PUT /api/spaces/:id/packages/:packageId requires a prior placement (CRIT-05)", () => {
    function putPackage(packageId: string, body: Record<string, unknown> = { modelId: null }) {
      return app.request(`/api/spaces/${ctx.defaultSpaceId}/packages/${packageId}`, {
        method: "PATCH",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    function placementRowWhere(packageId: string) {
      return and(
        eq(spacePackages.spaceId, ctx.defaultSpaceId),
        eq(spacePackages.packageId, packageId),
      )!;
    }

    it("404s for an org-owned package that is NOT placed here, and creates no row", async () => {
      // The package exists and is visible to the org — only the placement is missing.
      await seedPackage({ id: "@testorg/not-placed", orgId: ctx.orgId });

      const res = await putPackage("@testorg/not-placed");

      expect(res.status).toBe(404);
      // The regression: pre-fix this PUT upserted the row (implicit placement).
      await assertDbMissing(spacePackages, placementRowWhere("@testorg/not-placed"));
    });

    it("succeeds on the exact same PUT once the package IS placed (feature intact)", async () => {
      await seedPackage({
        id: "@testorg/placed-pkg",
        orgId: ctx.orgId,
        homeSpaceId: ctx.defaultSpaceId,
      });
      await seedSpacePackage(ctx.defaultSpaceId, "@testorg/placed-pkg");

      const res = await putPackage("@testorg/placed-pkg", { proxyId: null });

      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { object: string };
      expect(body.object).toBe("space_package");
    });

    /**
     * An ORPHAN row — `space_packages` with neither a home nor a share behind
     * it — is the inherited residue `scripts/migration/0016` repairs, and the
     * placement rule reads it as absent everywhere. The UPDATE used to test
     * for a ROW instead, so it landed on the orphan and the route's follow-up
     * `getSpacePackage` (placement-joined) then found nothing: a 200 whose
     * whole body was `{"object":"space_package"}`.
     *
     * The message "is not placed in this space" is now literally true.
     */
    it("404s on an ORPHAN row, writes nothing, and succeeds once a share PLACES the package", async () => {
      const ORPHAN = "@testorg/orphan-row";
      // Homed in ANOTHER team space of the org: the owner reaches it, so the
      // route's gate passes and the refusal read below is the placement
      // conjunct rather than an authorization refusal standing in for it.
      const elsewhere = await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" });
      await seedPackage({ id: ORPHAN, orgId: ctx.orgId, homeSpaceId: elsewhere.id });
      // The row, and ONLY the row: no home here, no offer here.
      await seedSpacePackage(ctx.defaultSpaceId, ORPHAN, { proxyId: "prx_before" });

      const refused = await putPackage(ORPHAN, { proxyId: "prx_after" });
      expect(refused.status, await refused.clone().text()).toBe(404);
      expect(await refused.json()).toMatchObject({
        code: "not_found",
        detail: `Package '${ORPHAN}' is not placed in this space`,
      });
      // The write did not land on the orphan.
      const [untouched] = await db
        .select({ proxyId: spacePackages.proxyId })
        .from(spacePackages)
        .where(placementRowWhere(ORPHAN));
      expect(untouched?.proxyId).toBe("prx_before");

      // The discriminating control: same row, same request, one offer apart.
      await seedPackageShare(ctx.defaultSpaceId, ORPHAN);

      const ok = await putPackage(ORPHAN, { proxyId: "prx_after" });
      expect(ok.status, await ok.clone().text()).toBe(200);
      // The FULL body — pre-fix the orphan path answered 200 with nothing but
      // `object`, because the follow-up read applies the placement rule.
      expect((await ok.json()) as { packageId?: string }).toMatchObject({
        object: "space_package",
        packageId: ORPHAN,
      });
      const [written] = await db
        .select({ proxyId: spacePackages.proxyId })
        .from(spacePackages)
        .where(placementRowWhere(ORPHAN));
      expect(written?.proxyId).toBe("prx_after");
    });

    it("refuses an `enabled` key — activation is not a setting on this body", async () => {
      // `enabled` left this route when activation got its own pair of doors.
      // `.strict()` makes the retired field FAIL loudly rather than be dropped
      // in silence, and the row keeps the state the doors gave it.
      await seedPackage({
        id: "@testorg/no-enabled-here",
        orgId: ctx.orgId,
        homeSpaceId: ctx.defaultSpaceId,
      });
      await seedSpacePackage(ctx.defaultSpaceId, "@testorg/no-enabled-here");

      const res = await putPackage("@testorg/no-enabled-here", { enabled: false });

      expect(res.status, await res.clone().text()).toBe(400);
      expect(await res.json()).toMatchObject({ code: "validation_failed" });
      const [row] = await db
        .select({ enabled: spacePackages.enabled })
        .from(spacePackages)
        .where(placementRowWhere("@testorg/no-enabled-here"));
      expect(row?.enabled).toBe(true);
    });

    // The agent's stored input values have ONE write path
    // (`PUT /api/agents/{scope}/{name}/input-settings`, which validates them
    // against the manifest input schema and refuses an unsatisfiable locked
    // required field). This generic route must not be a second, unvalidated one.
    it("refuses an `input_settings` key in the body — it is not a write path for stored input values", async () => {
      await seedPackage({
        id: "@testorg/no-input-settings-write",
        orgId: ctx.orgId,
        homeSpaceId: ctx.defaultSpaceId,
      });
      await seedSpacePackage(ctx.defaultSpaceId, "@testorg/no-input-settings-write");

      const res = await putPackage("@testorg/no-input-settings-write", {
        input_settings: { values: { hello: "world" }, locked: [] },
      });

      // The body is `.strict()`, so this is a 400 that names the field rather
      // than a 200 that quietly drops it — the caller learns its write did not
      // happen instead of believing it did.
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "validation_failed" });
      const [row] = await db
        .select({ inputSettings: spacePackages.inputSettings })
        .from(spacePackages)
        .where(placementRowWhere("@testorg/no-input-settings-write"));
      expect(row?.inputSettings).toEqual({ values: {}, locked: [] });
    });

    it("rejects unsupported generation settings instead of persisting them", async () => {
      const packageId = "@testorg/generation-agent";
      await seedPackage({ id: packageId, orgId: ctx.orgId, homeSpaceId: ctx.defaultSpaceId });
      await seedSpacePackage(ctx.defaultSpaceId, packageId);
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
        .where(placementRowWhere(packageId));
      expect(row?.modelId).toBeNull();
    });

    // Same refusal, same message, its own wire field — the invariant the
    // hoisted `validateGenerationOverride` establishes across all three routes
    // that run this pipeline (see the sibling case in `agents.test.ts`).
    it("names the generationConfig field when no model resolves at all", async () => {
      const packageId = "@testorg/no-model-generation-agent";
      await seedPackage({ id: packageId, orgId: ctx.orgId, homeSpaceId: ctx.defaultSpaceId });
      await seedSpacePackage(ctx.defaultSpaceId, packageId);

      const res = await putPackage(packageId, {
        modelId: null,
        generationConfig: { temperature: 0.4 },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "invalid_request",
        param: "generationConfig",
        detail: "A model must be configured before generation settings can be saved",
      });
    });

    // Control for the reconcile rule the three routes now state identically:
    // a patch that does NOT carry `modelId` cannot have changed the selected
    // model, so stored generation settings are left exactly as they were —
    // never silently rewritten by an unrelated field's update.
    it("leaves stored generation settings untouched on a patch without modelId", async () => {
      const packageId = "@testorg/untouched-generation-agent";
      await seedPackage({ id: packageId, orgId: ctx.orgId, homeSpaceId: ctx.defaultSpaceId });
      await seedSpacePackage(ctx.defaultSpaceId, packageId, {
        generationConfig: { temperature: 0.7 },
      });

      // A patch that never names `modelId` cannot have changed the model, so
      // there is nothing to re-clamp against.
      const res = await putPackage(packageId, { proxyId: null });

      expect(res.status, await res.clone().text()).toBe(200);
      const [row] = await db
        .select({ generation: spacePackages.generationConfig })
        .from(spacePackages)
        .where(placementRowWhere(packageId));
      expect(row?.generation).toEqual({ temperature: 0.7 });
    });

    it("reconciles persisted generation defaults when the model changes", async () => {
      const packageId = "@testorg/reconciled-agent";
      await seedPackage({ id: packageId, orgId: ctx.orgId, homeSpaceId: ctx.defaultSpaceId });
      await seedSpacePackage(ctx.defaultSpaceId, packageId, {
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
        .where(placementRowWhere(packageId));
      expect(row?.generation).toEqual({});
    });

    it("404s for a package owned by ANOTHER org, and creates no association row", async () => {
      const foreignCtx = await createTestContext({ orgSlug: "foreignorg" });
      await seedPackage({ id: "@foreignorg/theirs", orgId: foreignCtx.orgId });

      const res = await putPackage("@foreignorg/theirs");

      expect(res.status).toBe(404);
      await assertDbMissing(spacePackages, placementRowWhere("@foreignorg/theirs"));
    });
  });

  // ── CRIT-05 — a historical stray association must not leak on the list ──
  //
  // The old unconditional-upsert PUT could create an `space_packages`
  // row pointing at ANOTHER org's package. Blocking new creations is not
  // enough: `listSpacePackages` must also refuse to resolve such a row,
  // or the foreign package's draft_manifest leaks through
  // `GET /api/spaces/:id/packages`.
  describe("GET /api/spaces/:id/packages excludes stray cross-org associations (CRIT-05)", () => {
    it("omits a foreign-org package attached by a corrupted association row", async () => {
      const foreignCtx = await createTestContext({ orgSlug: "foreignorg" });
      await seedPackage({ id: "@foreignorg/leaky", orgId: foreignCtx.orgId });
      await seedPackage({ id: "@testorg/mine", orgId: ctx.orgId, homeSpaceId: ctx.defaultSpaceId });
      // Insert both associations directly in DB — the stray one simulates a
      // row created by the pre-fix vulnerable PUT. It is given the OFFER too,
      // so the placement rule cannot be what excludes it: only the org
      // boundary can, which is the assertion this test exists for.
      await seedPackageShare(ctx.defaultSpaceId, "@foreignorg/leaky");
      await seedSpacePackage(ctx.defaultSpaceId, "@foreignorg/leaky");
      await seedSpacePackage(ctx.defaultSpaceId, "@testorg/mine");

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
