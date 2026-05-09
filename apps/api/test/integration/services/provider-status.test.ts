// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedConnectionProfile, seedPackage, seedConnectionForApp } from "../../helpers/seed.ts";
import { applicationProviderCredentials } from "@appstrate/db/schema";
import { resolveProviderStatuses } from "../../../src/services/connection-manager/status.ts";
import type { AgentProviderRequirement, ProviderProfileMap } from "../../../src/types/index.ts";

describe("resolveProviderStatuses", () => {
  let userId: string;
  let orgId: string;
  let applicationId: string;
  let connectionProfileId: string;

  beforeEach(async () => {
    await truncateAll();
    const { id } = await createTestUser({ name: "Alice" });
    userId = id;
    const { org, defaultAppId } = await createTestOrg(userId);
    orgId = org.id;
    applicationId = defaultAppId;

    const profile = await seedConnectionProfile({ userId, name: "Alice Profile" });
    connectionProfileId = profile.id;
  });

  async function seedProvider(id: string) {
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
    await db.insert(applicationProviderCredentials).values({
      applicationId: applicationId,
      providerId: id,
      credentialsEncrypted: "{}",
      enabled: true,
    });
  }

  it("returns source and profileName for user_profile entry", async () => {
    const providerId = "@system/test-status";
    await seedProvider(providerId);
    await seedConnectionForApp(connectionProfileId, providerId, orgId, applicationId, { api_key: "k" });

    const providers: AgentProviderRequirement[] = [{ id: providerId }];
    const profiles: ProviderProfileMap = {
      [providerId]: { connectionProfileId, source: "user_profile" },
    };

    const statuses = await resolveProviderStatuses(
      { orgId: orgId, applicationId: applicationId },
      providers,
      profiles,
    );
    expect(statuses).toHaveLength(1);
    const s0 = statuses[0]!;
    expect(s0.status).toBe("connected");
    expect(s0.source).toBe("user_profile");
    expect(s0.profileName).toBe("Alice Profile");
    expect(s0.profileOwnerName).toBe("Alice");
  });

  it("returns source org_binding with correct profile info", async () => {
    const providerId = "@system/test-org-bind";
    await seedProvider(providerId);
    await seedConnectionForApp(connectionProfileId, providerId, orgId, applicationId, { api_key: "k" });

    const providers: AgentProviderRequirement[] = [{ id: providerId }];
    const profiles: ProviderProfileMap = {
      [providerId]: { connectionProfileId, source: "app_binding" },
    };

    const statuses = await resolveProviderStatuses(
      { orgId: orgId, applicationId: applicationId },
      providers,
      profiles,
    );
    const s0 = statuses[0]!;
    expect(s0.source).toBe("app_binding");
    expect(s0.profileName).toBe("Alice Profile");
    expect(s0.profileOwnerName).toBe("Alice");
  });

  it("returns null profileName when profile does not exist", async () => {
    const providerId = "@system/test-deleted";
    await seedProvider(providerId);

    const providers: AgentProviderRequirement[] = [{ id: providerId }];
    const profiles: ProviderProfileMap = {
      [providerId]: {
        connectionProfileId: "00000000-0000-0000-0000-000000000000",
        source: "user_profile",
      },
    };

    const statuses = await resolveProviderStatuses(
      { orgId: orgId, applicationId: applicationId },
      providers,
      profiles,
    );
    const s0 = statuses[0]!;
    expect(s0.profileName).toBeNull();
    expect(s0.profileOwnerName).toBeNull();
  });

  it("returns no source when no entry in providerProfiles", async () => {
    const providerId = "@system/test-no-entry";
    await seedProvider(providerId);

    const providers: AgentProviderRequirement[] = [{ id: providerId }];
    const profiles: ProviderProfileMap = {};

    const statuses = await resolveProviderStatuses(
      { orgId: orgId, applicationId: applicationId },
      providers,
      profiles,
    );
    const s0 = statuses[0]!;
    expect(s0.status).toBe("not_connected");
    expect(s0.source).toBeNull();
    expect(s0.profileName).toBeNull();
    expect(s0.profileOwnerName).toBeNull();
  });
});
