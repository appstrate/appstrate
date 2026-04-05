// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedProviderCredentials, seedApplication } from "../../helpers/seed.ts";
import { isProviderEnabled } from "@appstrate/connect";
import { db } from "../../helpers/db.ts";

describe("isProviderEnabled with application-level credentials", () => {
  let ctx: TestContext;
  const providerId = "@testorg/test-provider";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });

    await seedPackage({
      id: providerId,
      orgId: ctx.orgId,
      type: "provider",
      draftManifest: {
        name: providerId,
        type: "provider",
        version: "1.0.0",
        definition: { authMode: "api_key" },
      },
    });
  });

  it("returns true when enabled at app level", async () => {
    await seedProviderCredentials({ applicationId: ctx.defaultAppId, providerId, enabled: true });
    const result = await isProviderEnabled(db, ctx.orgId, providerId, ctx.defaultAppId);
    expect(result).toBe(true);
  });

  it("returns false when disabled at app level", async () => {
    await seedProviderCredentials({ applicationId: ctx.defaultAppId, providerId, enabled: false });
    const result = await isProviderEnabled(db, ctx.orgId, providerId, ctx.defaultAppId);
    expect(result).toBe(false);
  });

  it("returns false when no credentials row exists", async () => {
    const result = await isProviderEnabled(db, ctx.orgId, providerId, ctx.defaultAppId);
    expect(result).toBe(false);
  });

  it("app-level override only affects the target application", async () => {
    await seedProviderCredentials({ applicationId: ctx.defaultAppId, providerId, enabled: true });

    // Create a second application
    const otherApp = await seedApplication({ orgId: ctx.orgId, name: "Other App" });

    // Disable provider for the other app
    await seedProviderCredentials({ applicationId: otherApp.id, providerId, enabled: false });

    // Default app should still see the provider enabled
    const resultDefault = await isProviderEnabled(db, ctx.orgId, providerId, ctx.defaultAppId);
    expect(resultDefault).toBe(true);

    // Other app should see it disabled
    const resultOther = await isProviderEnabled(db, ctx.orgId, providerId, otherApp.id);
    expect(resultOther).toBe(false);
  });
});
