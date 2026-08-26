// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `GET /api/spaces/{spaceId}/packages/{scope}/{name}/run-config`
 * — the resolver the CLI calls to reproduce a UI run.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, and } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { spacePackages } from "@appstrate/db/schema";

const app = getTestApp();

describe("GET /api/spaces/:spaceId/packages/:scope/:name/run-config", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("returns the resolved run configuration for an installed package", async () => {
    await seedPackage({
      orgId: ctx.orgId,
      id: "@testorg/agent",
      type: "agent",
      draftManifest: {
        name: "@testorg/agent",
        version: "1.0.0",
        type: "agent",
        dependencies: { integrations: { "@afps/gmail": "^1.0.0" } },
      },
    });
    const version = await seedPackageVersion({
      packageId: "@testorg/agent",
      version: "1.2.3",
    });

    await db.insert(spacePackages).values({
      spaceId: ctx.defaultSpaceId,
      packageId: "@testorg/agent",
      modelId: "claude-sonnet",
      generationConfig: { temperature: 0.2, reasoningLevel: "high" },
      proxyId: null,
      versionId: version.id,
    });

    const res = await app.request(
      `/api/spaces/${ctx.defaultSpaceId}/packages/@testorg/agent/run-config`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      generation: { temperature: 0.2, reasoningLevel: "high" },
      input: { values: {}, locked_fields: [] },
      modelId: "claude-sonnet",
      proxyId: null,
      version_pin: "1.2.3",
    });
    // `input` carries the per-space layer, and it is NOT a second source
    // of truth. This endpoint feeds `appstrate run @scope/agent`, which fetches
    // the bundle and executes it LOCALLY — that path never reaches the server's
    // resolver, so without these values it applies author defaults only and
    // runs the agent with parameters the dashboard would not have used. Layers
    // 3-4 stay server-owned; `resolveEffectiveInput` keeps one implementation.
    expect(body).not.toHaveProperty("config");
  });

  it("carries the stored values and locks the editor set", async () => {
    await seedPackage({
      orgId: ctx.orgId,
      id: "@testorg/agent",
      type: "agent",
      draftManifest: { name: "@testorg/agent", version: "1.0.0", type: "agent" },
    });
    await db.insert(spacePackages).values({
      spaceId: ctx.defaultSpaceId,
      packageId: "@testorg/agent",
      inputSettings: { values: { folder: "archive" }, locked: ["folder"] },
    });

    const res = await app.request(
      `/api/spaces/${ctx.defaultSpaceId}/packages/@testorg/agent/run-config`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.input).toEqual({ values: { folder: "archive" }, locked_fields: ["folder"] });
  });

  it("returns 404 when the package is not installed in the space", async () => {
    await seedPackage({
      orgId: ctx.orgId,
      id: "@testorg/agent",
      type: "agent",
    });
    const res = await app.request(
      `/api/spaces/${ctx.defaultSpaceId}/packages/@testorg/agent/run-config`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("package_not_installed");
  });

  it("returns null versionPin when no version is pinned", async () => {
    await seedPackage({
      orgId: ctx.orgId,
      id: "@testorg/agent",
      type: "agent",
    });
    await db.insert(spacePackages).values({
      spaceId: ctx.defaultSpaceId,
      packageId: "@testorg/agent",
    });
    const res = await app.request(
      `/api/spaces/${ctx.defaultSpaceId}/packages/@testorg/agent/run-config`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.version_pin).toBeNull();
    expect(body.modelId).toBeNull();
    expect(body.proxyId).toBeNull();
    expect(body.generation).toBeNull();
  });

  it("returns 401 without authentication", async () => {
    const res = await app.request(
      `/api/spaces/${ctx.defaultSpaceId}/packages/@testorg/agent/run-config`,
    );
    expect(res.status).toBe(401);
  });

  // Tenancy isolation: one package installed in two spaces of the SAME
  // org must resolve to the row of the space named in the path, never
  // the other one. Discriminated on `modelId` (a scalar) and `generation` (a
  // JSONB object) so a leak is caught on both kinds of column the resolver
  // projects — the same coverage the retired per-space `config` object gave.
  it("scopes to the requested space — no cross-space leakage", async () => {
    await seedPackage({ orgId: ctx.orgId, id: "@testorg/agent", type: "agent" });
    await db.insert(spacePackages).values({
      spaceId: ctx.defaultSpaceId,
      packageId: "@testorg/agent",
      modelId: "model-of-default-space",
      generationConfig: { temperature: 0.1 },
    });

    // Create a second space and install with different overrides
    const otherSpaceRes = await app.request("/api/spaces", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Other Space" }),
    });
    const otherSpaceId = ((await otherSpaceRes.json()) as { id: string }).id;
    await db.insert(spacePackages).values({
      spaceId: otherSpaceId,
      packageId: "@testorg/agent",
      modelId: "model-of-other-space",
      generationConfig: { temperature: 0.9 },
    });

    // The route uses the path's spaceId, not the X-Space-Id header — we
    // pass X-Space-Id matching the path so the space-context middleware
    // accepts the call, then verify the response is scoped to that space.
    const res = await app.request(
      `/api/spaces/${otherSpaceId}/packages/@testorg/agent/run-config`,
      {
        headers: { ...authHeaders(ctx), "X-Space-Id": otherSpaceId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modelId: string | null;
      generation: Record<string, unknown> | null;
    };
    expect(body.modelId).toBe("model-of-other-space");
    expect(body.generation).toEqual({ temperature: 0.9 });
    // The leak this guards against, stated negatively.
    expect(body.modelId).not.toBe("model-of-default-space");
    expect(body.generation).not.toEqual({ temperature: 0.1 });

    // Cleanup so subsequent tests don't see the second row
    await db
      .delete(spacePackages)
      .where(
        and(eq(spacePackages.spaceId, otherSpaceId), eq(spacePackages.packageId, "@testorg/agent")),
      );
  });
});
