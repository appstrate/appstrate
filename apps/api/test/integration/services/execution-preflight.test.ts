import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedFlow, seedConnectionProfile, seedPackage } from "../../helpers/seed.ts";
import { saveConnection } from "@appstrate/connect";
import { providerCredentials } from "@appstrate/db/schema";
import { resolvePreflightContext } from "../../../src/services/env-builder.ts";
import { getPackage } from "../../../src/services/flow-service.ts";
import {
  setUserFlowProviderOverride,
  getDefaultProfileId,
} from "../../../src/services/connection-profiles.ts";
import { bindOrgProfileProvider } from "../../../src/services/state/org-profile-bindings.ts";
import type { Actor } from "../../../src/lib/actor.ts";

describe("execution preflight — provider profile resolution", () => {
  let userId: string;
  let orgId: string;
  let actor: Actor;
  let defaultProfileId: string;
  let altProfileId: string;

  const providerIds = ["@system/gmail", "@system/clickup"];

  beforeEach(async () => {
    await truncateAll();
    const { id, cookie } = await createTestUser();
    userId = id;
    const { org } = await createTestOrg(userId);
    orgId = org.id;
    actor = { type: "member", id: userId };

    // Seed provider packages + enable them
    for (const pid of providerIds) {
      await seedPackage({
        orgId: null as unknown as string,
        id: pid,
        type: "provider",
        source: "system",
        draftManifest: {
          name: pid,
          version: "1.0.0",
          type: "provider",
          description: pid,
          definition: { authMode: "api_key" },
        },
      });
      await db.insert(providerCredentials).values({
        providerId: pid,
        orgId,
        credentialsEncrypted: "{}",
        enabled: true,
      });
    }

    // Default profile + connections for both providers
    defaultProfileId = await getDefaultProfileId(actor);
    for (const pid of providerIds) {
      await saveConnection(db, defaultProfileId, pid, orgId, { api_key: "default-key" });
    }

    // Alt profile + connection for gmail only
    const alt = await seedConnectionProfile({ userId, name: "Alt" });
    altProfileId = alt.id;
    await saveConnection(db, altProfileId, "@system/gmail", orgId, { api_key: "alt-key" });
  });

  async function seedFlowWithProviders(flowId: string) {
    await seedFlow({
      id: flowId,
      orgId,
      createdBy: userId,
      draftManifest: {
        name: flowId,
        version: "0.1.0",
        type: "flow",
        description: "Test",
        dependencies: {
          providers: Object.fromEntries(providerIds.map((id) => [id, "*"])),
        },
      },
    });
    return (await getPackage(flowId, orgId))!;
  }

  it("uses default profile for all providers when no overrides", async () => {
    const flowId = "@testorg/preflight-default";
    const flow = await seedFlowWithProviders(flowId);

    const { providerProfiles } = await resolvePreflightContext({
      flow,
      packageId: flowId,
      orgId,
      defaultUserProfileId: defaultProfileId,
    });

    expect(providerProfiles["@system/gmail"]!.profileId).toBe(defaultProfileId);
    expect(providerProfiles["@system/gmail"]!.source).toBe("user_profile");
    expect(providerProfiles["@system/clickup"]!.profileId).toBe(defaultProfileId);
    expect(providerProfiles["@system/clickup"]!.source).toBe("user_profile");
  });

  it("applies per-provider override for a specific provider", async () => {
    const flowId = "@testorg/preflight-override";
    const flow = await seedFlowWithProviders(flowId);

    const { providerProfiles } = await resolvePreflightContext({
      flow,
      packageId: flowId,
      orgId,
      defaultUserProfileId: defaultProfileId,
      userProviderOverrides: { "@system/gmail": altProfileId },
    });

    expect(providerProfiles["@system/gmail"]!.profileId).toBe(altProfileId);
    expect(providerProfiles["@system/gmail"]!.source).toBe("user_profile");
    expect(providerProfiles["@system/clickup"]!.profileId).toBe(defaultProfileId);
  });

  it("org binding takes priority over per-provider override", async () => {
    const flowId = "@testorg/preflight-org";
    const flow = await seedFlowWithProviders(flowId);

    // Create org profile + bind gmail to alt profile
    const orgProfile = await seedConnectionProfile({ orgId, name: "Org" });
    await bindOrgProfileProvider(orgProfile.id, "@system/gmail", altProfileId, userId);

    const { providerProfiles } = await resolvePreflightContext({
      flow,
      packageId: flowId,
      orgId,
      defaultUserProfileId: defaultProfileId,
      userProviderOverrides: { "@system/gmail": defaultProfileId },
      orgProfileId: orgProfile.id,
    });

    expect(providerProfiles["@system/gmail"]!.profileId).toBe(altProfileId);
    expect(providerProfiles["@system/gmail"]!.source).toBe("org_binding");
    // clickup not bound in org profile -> falls back to user override or default
    expect(providerProfiles["@system/clickup"]!.profileId).toBe(defaultProfileId);
    expect(providerProfiles["@system/clickup"]!.source).toBe("user_profile");
  });

  it("unbound provider uses per-provider override even with org profile", async () => {
    const flowId = "@testorg/preflight-mixed";
    const flow = await seedFlowWithProviders(flowId);

    const orgProfile = await seedConnectionProfile({ orgId, name: "Org" });
    // Only bind gmail, NOT clickup
    await bindOrgProfileProvider(orgProfile.id, "@system/gmail", altProfileId, userId);

    // Provide override for clickup
    await saveConnection(db, altProfileId, "@system/clickup", orgId, { api_key: "alt-cu" });

    const { providerProfiles } = await resolvePreflightContext({
      flow,
      packageId: flowId,
      orgId,
      defaultUserProfileId: defaultProfileId,
      userProviderOverrides: { "@system/clickup": altProfileId },
      orgProfileId: orgProfile.id,
    });

    expect(providerProfiles["@system/gmail"]!.source).toBe("org_binding");
    expect(providerProfiles["@system/clickup"]!.profileId).toBe(altProfileId);
    expect(providerProfiles["@system/clickup"]!.source).toBe("user_profile");
  });
});
