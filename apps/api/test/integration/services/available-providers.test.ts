// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for getAvailableProvidersWithStatus filtering by application credentials.
 *
 * Verifies that providers are only returned when the application has
 * enabled credentials configured for them.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import {
  seedConnectionProfile,
  seedProviderCredentials,
  seedPackage,
  seedApplication,
  seedConnectionForApp,
} from "../../helpers/seed.ts";
import { getAvailableProvidersWithStatus } from "../../../src/services/connection-manager/providers.ts";

describe("getAvailableProvidersWithStatus", () => {
  let userId: string;
  let orgId: string;
  let app1Id: string;
  let app2Id: string;
  let connectionProfileId: string;

  /** Seed a system provider package with api_key auth mode. */
  async function seedSystemProvider(id: string) {
    await seedPackage({
      orgId: null,
      id,
      type: "provider",
      source: "system",
      draftManifest: {
        name: id,
        version: "1.0.0",
        type: "provider",
        description: `Provider ${id}`,
        definition: { authMode: "api_key" },
      },
    });
  }

  beforeEach(async () => {
    await truncateAll();
    const user = await createTestUser();
    userId = user.id;
    const { org, defaultAppId } = await createTestOrg(userId);
    orgId = org.id;
    app1Id = defaultAppId;

    const app2 = await seedApplication({ orgId, name: "App2" });
    app2Id = app2.id;

    const profile = await seedConnectionProfile({ userId, name: "Default", isDefault: true });
    connectionProfileId = profile.id;
  });

  it("includes provider when app has enabled credentials configured", async () => {
    const providerId = "@system/gmail";
    await seedSystemProvider(providerId);
    await seedProviderCredentials({ applicationId: app1Id, providerId, enabled: true });

    const result = await getAvailableProvidersWithStatus(
      { orgId: orgId, applicationId: app1Id },
      connectionProfileId,
    );
    const providerIds = result.map((p) => p.provider);
    expect(providerIds).toContain(providerId);
  });

  it("excludes provider from app that has no credentials configured", async () => {
    const providerId = "@system/gmail";
    await seedSystemProvider(providerId);

    // Configure credentials only for App1
    await seedProviderCredentials({ applicationId: app1Id, providerId, enabled: true });

    // App2 has no credentials — provider should not appear
    const result = await getAvailableProvidersWithStatus(
      { orgId: orgId, applicationId: app2Id },
      connectionProfileId,
    );
    const providerIds = result.map((p) => p.provider);
    expect(providerIds).not.toContain(providerId);
  });

  it("shows connected status when user has a connection for the app", async () => {
    const providerId = "@system/clickup";
    await seedSystemProvider(providerId);
    await seedConnectionForApp(connectionProfileId, providerId, orgId, app1Id, { api_key: "ck1" });

    const result = await getAvailableProvidersWithStatus(
      { orgId: orgId, applicationId: app1Id },
      connectionProfileId,
    );
    const provider = result.find((p) => p.provider === providerId);
    expect(provider).toBeDefined();
    expect(provider!.status).toBe("connected");
  });

  it("shows not_connected when user has no connection even if credentials exist", async () => {
    const providerId = "@system/slack";
    await seedSystemProvider(providerId);
    await seedProviderCredentials({ applicationId: app1Id, providerId, enabled: true });

    const result = await getAvailableProvidersWithStatus(
      { orgId: orgId, applicationId: app1Id },
      connectionProfileId,
    );
    const provider = result.find((p) => p.provider === providerId);
    expect(provider).toBeDefined();
    expect(provider!.status).toBe("not_connected");
  });
});
