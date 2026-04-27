// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `GET /api/applications/{appId}/packages/{scope}/{name}/run-config`
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

describe("GET /api/applications/:appId/packages/:scope/:name/run-config", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("returns the resolved config for an installed package", async () => {
    await seedPackage({
      orgId: ctx.orgId,
      id: "@testorg/agent",
      type: "agent",
      draftManifest: {
        name: "@testorg/agent",
        version: "1.0.0",
        type: "agent",
        dependencies: { providers: { "@afps/gmail": "^1.0.0" } },
      },
    });
    const version = await seedPackageVersion({
      packageId: "@testorg/agent",
      version: "1.2.3",
    });

    await db.insert(applicationPackages).values({
      applicationId: ctx.defaultAppId,
      packageId: "@testorg/agent",
      config: { dryRun: true, retries: 3 },
      modelId: "claude-sonnet",
      proxyId: null,
      versionId: version.id,
    });

    const res = await app.request(
      `/api/applications/${ctx.defaultAppId}/packages/@testorg/agent/run-config`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      config: { dryRun: true, retries: 3 },
      modelId: "claude-sonnet",
      proxyId: null,
      versionPin: "1.2.3",
      requiredProviders: ["@afps/gmail"],
    });
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
      config: {},
    });
    const res = await app.request(
      `/api/applications/${ctx.defaultAppId}/packages/@testorg/agent/run-config`,
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.versionPin).toBeNull();
    expect(body.modelId).toBeNull();
    expect(body.proxyId).toBeNull();
  });

  it("returns 401 without authentication", async () => {
    const res = await app.request(
      `/api/applications/${ctx.defaultAppId}/packages/@testorg/agent/run-config`,
    );
    expect(res.status).toBe(401);
  });

  it("scopes to the requested application — no cross-app leakage", async () => {
    await seedPackage({ orgId: ctx.orgId, id: "@testorg/agent", type: "agent" });
    await db.insert(applicationPackages).values({
      applicationId: ctx.defaultAppId,
      packageId: "@testorg/agent",
      config: { from: "default-app" },
    });

    // Create a second app and install with a different config
    const otherAppRes = await app.request("/api/applications", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Other App" }),
    });
    const otherAppId = ((await otherAppRes.json()) as { id: string }).id;
    await db.insert(applicationPackages).values({
      applicationId: otherAppId,
      packageId: "@testorg/agent",
      config: { from: "other-app" },
    });

    // The route uses the path's appId, not the X-App-Id header — we
    // pass X-App-Id matching the path so the app-context middleware
    // accepts the call, then verify the response is scoped to that app.
    const res = await app.request(
      `/api/applications/${otherAppId}/packages/@testorg/agent/run-config`,
      {
        headers: { ...authHeaders(ctx), "X-App-Id": otherAppId },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: Record<string, unknown> };
    expect(body.config).toEqual({ from: "other-app" });

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
