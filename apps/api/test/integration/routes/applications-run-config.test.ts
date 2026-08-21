// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `GET /api/applications/{applicationId}/packages/{scope}/{name}/run-config`
 * — the resolver the CLI calls to reproduce a UI run.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, and } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { applicationPackages } from "@appstrate/db/schema";

const app = getTestApp();

describe("GET /api/applications/:applicationId/packages/:scope/:name/run-config", () => {
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

    await db.insert(applicationPackages).values({
      applicationId: ctx.defaultAppId,
      packageId: "@testorg/agent",
      modelId: "claude-sonnet",
      generationConfig: { temperature: 0.2, reasoningLevel: "high" },
      proxyId: null,
      versionId: version.id,
    });

    const res = await app.request(
      `/api/applications/${ctx.defaultAppId}/packages/@testorg/agent/run-config`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      generation: { temperature: 0.2, reasoningLevel: "high" },
      modelId: "claude-sonnet",
      proxyId: null,
      version_pin: "1.2.3",
    });
    // The agent's stored input values are deliberately absent: this endpoint
    // is CLI-facing, and a CLI-triggered platform run has the server resolve
    // the whole author -> editor -> schedule -> caller chain. Exposing them
    // here would be a second source of truth for the same values.
    expect(body).not.toHaveProperty("config");
  });

  it("returns 404 when the package is not installed in the app", async () => {
    await seedPackage({
      orgId: ctx.orgId,
      id: "@testorg/agent",
      type: "agent",
    });
    const res = await app.request(
      `/api/applications/${ctx.defaultAppId}/packages/@testorg/agent/run-config`,
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
    await db.insert(applicationPackages).values({
      applicationId: ctx.defaultAppId,
      packageId: "@testorg/agent",
    });
    const res = await app.request(
      `/api/applications/${ctx.defaultAppId}/packages/@testorg/agent/run-config`,
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
      `/api/applications/${ctx.defaultAppId}/packages/@testorg/agent/run-config`,
    );
    expect(res.status).toBe(401);
  });

  // Tenancy isolation: one package installed in two applications of the SAME
  // org must resolve to the row of the application named in the path, never
  // the other one. Discriminated on `modelId` (a scalar) and `generation` (a
  // JSONB object) so a leak is caught on both kinds of column the resolver
  // projects — the same coverage the retired per-app `config` object gave.
  it("scopes to the requested application — no cross-app leakage", async () => {
    await seedPackage({ orgId: ctx.orgId, id: "@testorg/agent", type: "agent" });
    await db.insert(applicationPackages).values({
      applicationId: ctx.defaultAppId,
      packageId: "@testorg/agent",
      modelId: "model-of-default-app",
      generationConfig: { temperature: 0.1 },
    });

    // Create a second app and install with different overrides
    const otherAppRes = await app.request("/api/applications", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Other App" }),
    });
    const otherAppId = ((await otherAppRes.json()) as { id: string }).id;
    await db.insert(applicationPackages).values({
      applicationId: otherAppId,
      packageId: "@testorg/agent",
      modelId: "model-of-other-app",
      generationConfig: { temperature: 0.9 },
    });

    // The route uses the path's applicationId, not the X-Application-Id header — we
    // pass X-Application-Id matching the path so the app-context middleware
    // accepts the call, then verify the response is scoped to that app.
    const res = await app.request(
      `/api/applications/${otherAppId}/packages/@testorg/agent/run-config`,
      {
        headers: { ...authHeaders(ctx), "X-Application-Id": otherAppId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modelId: string | null;
      generation: Record<string, unknown> | null;
    };
    expect(body.modelId).toBe("model-of-other-app");
    expect(body.generation).toEqual({ temperature: 0.9 });
    // The leak this guards against, stated negatively.
    expect(body.modelId).not.toBe("model-of-default-app");
    expect(body.generation).not.toEqual({ temperature: 0.1 });

    // Cleanup so subsequent tests don't see the second row
    await db
      .delete(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, otherAppId),
          eq(applicationPackages.packageId, "@testorg/agent"),
        ),
      );
  });
});
