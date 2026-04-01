import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedConnectionProfile, seedPackage } from "../../helpers/seed.ts";
import { saveConnection } from "@appstrate/connect";
import { providerCredentials } from "@appstrate/db/schema";
import { resolveProviderStatuses } from "../../../src/services/connection-manager/status.ts";
import type { FlowProviderRequirement, ProviderProfileMap } from "../../../src/types/index.ts";

describe("resolveProviderStatuses", () => {
  let userId: string;
  let orgId: string;
  let profileId: string;

  beforeEach(async () => {
    await truncateAll();
    const { id, cookie } = await createTestUser({ name: "Alice" });
    userId = id;
    const { org } = await createTestOrg(userId);
    orgId = org.id;

    const profile = await seedConnectionProfile({ userId, name: "Alice Profile" });
    profileId = profile.id;
  });

  async function seedProvider(id: string) {
    await seedPackage({
      orgId: null as unknown as string,
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
    await db.insert(providerCredentials).values({
      providerId: id,
      orgId,
      credentialsEncrypted: "{}",
      enabled: true,
    });
  }

  it("returns source and profileName for user_profile entry", async () => {
    const providerId = "@system/test-status";
    await seedProvider(providerId);
    await saveConnection(db, profileId, providerId, orgId, { api_key: "k" });

    const providers: FlowProviderRequirement[] = [{ id: providerId }];
    const profiles: ProviderProfileMap = {
      [providerId]: { profileId, source: "user_profile" },
    };

    const statuses = await resolveProviderStatuses(providers, profiles, orgId);
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
    await saveConnection(db, profileId, providerId, orgId, { api_key: "k" });

    const providers: FlowProviderRequirement[] = [{ id: providerId }];
    const profiles: ProviderProfileMap = {
      [providerId]: { profileId, source: "org_binding" },
    };

    const statuses = await resolveProviderStatuses(providers, profiles, orgId);
    const s0 = statuses[0]!;
    expect(s0.source).toBe("org_binding");
    expect(s0.profileName).toBe("Alice Profile");
    expect(s0.profileOwnerName).toBe("Alice");
  });

  it("returns null profileName when profile does not exist", async () => {
    const providerId = "@system/test-deleted";
    await seedProvider(providerId);

    const providers: FlowProviderRequirement[] = [{ id: providerId }];
    const profiles: ProviderProfileMap = {
      [providerId]: {
        profileId: "00000000-0000-0000-0000-000000000000",
        source: "user_profile",
      },
    };

    const statuses = await resolveProviderStatuses(providers, profiles, orgId);
    const s0 = statuses[0]!;
    expect(s0.profileName).toBeNull();
    expect(s0.profileOwnerName).toBeNull();
  });

  it("returns no source when no entry in providerProfiles", async () => {
    const providerId = "@system/test-no-entry";
    await seedProvider(providerId);

    const providers: FlowProviderRequirement[] = [{ id: providerId }];
    const profiles: ProviderProfileMap = {};

    const statuses = await resolveProviderStatuses(providers, profiles, orgId);
    const s0 = statuses[0]!;
    expect(s0.status).toBe("not_connected");
    expect(s0.source).toBeUndefined();
    expect((s0 as any).profileName).toBeUndefined();
  });
});
