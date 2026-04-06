// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for listConnections filtering (per-app credential isolation).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import {
  seedConnectionProfile,
  seedProviderCredentials,
  seedPackage,
  seedConnectionForApp,
  seedApplication,
} from "../../helpers/seed.ts";
import { listConnections } from "@appstrate/connect";

describe("listConnections filtering", () => {
  let userId: string;
  let orgId: string;
  let appId: string;
  let profileId: string;

  beforeEach(async () => {
    await truncateAll();
    const user = await createTestUser();
    userId = user.id;
    const { org, defaultAppId } = await createTestOrg(userId);
    orgId = org.id;
    appId = defaultAppId;

    const profile = await seedConnectionProfile({ userId, name: "Default", isDefault: true });
    profileId = profile.id;
  });

  it("returns empty array when providerCredentialIds is empty", async () => {
    // Even if connections exist, passing [] should return nothing
    const providerId = "@system/gmail";
    await seedConnectionForApp(profileId, providerId, orgId, appId, { api_key: "k1" });

    const result = await listConnections(db, profileId, orgId, []);
    expect(result).toEqual([]);
  });

  it("returns only connections matching specific credential IDs", async () => {
    // Create two providers with credentials
    const providerA = "@system/gmail";
    const providerB = "@system/clickup";

    await seedConnectionForApp(profileId, providerA, orgId, appId, { api_key: "ka" });
    await seedConnectionForApp(profileId, providerB, orgId, appId, { api_key: "kb" });

    // Get credential ID for provider A only
    const credA = await seedProviderCredentials({ applicationId: appId, providerId: providerA });

    const result = await listConnections(db, profileId, orgId, [credA.id]);
    expect(result).toHaveLength(1);
    expect(result[0]!.providerId).toBe(providerA);
  });

  it("does not return connections from another app's credentials", async () => {
    const providerId = "@system/gmail";

    // Create connection in app A
    await seedConnectionForApp(profileId, providerId, orgId, appId, { api_key: "ka" });

    // Create a second application and seed credentials there
    const appB = await seedApplication({ orgId, name: "AppB" });
    const credB = await seedProviderCredentials({ applicationId: appB.id, providerId });

    // Query using only appB's credential ID — should not see appA's connection
    const result = await listConnections(db, profileId, orgId, [credB.id]);
    expect(result).toHaveLength(0);
  });
});
