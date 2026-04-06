// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import {
  seedAgent,
  seedConnectionProfile,
  seedPackage,
  seedConnectionForApp,
} from "../../helpers/seed.ts";
import { applicationProviderCredentials } from "@appstrate/db/schema";
import { resolveProviderProfiles } from "../../../src/services/connection-profiles.ts";
import { resolveManifestProviders } from "../../../src/lib/manifest-utils.ts";
import { getPackageConfig } from "../../../src/services/application-packages.ts";
import { validateAgentReadiness } from "../../../src/services/agent-readiness.ts";
import { getPackage } from "../../../src/services/agent-service.ts";
import { getDefaultProfileId } from "../../../src/services/connection-profiles.ts";
import { bindAppProfileProvider } from "../../../src/services/state/app-profile-bindings.ts";
import type { Actor } from "../../../src/lib/actor.ts";
import type { LoadedPackage, ProviderProfileMap } from "../../../src/types/index.ts";

describe("run preflight — provider profile resolution", () => {
  let userId: string;
  let orgId: string;
  let appId: string;
  let actor: Actor;
  let defaultProfileId: string;
  let altProfileId: string;

  const providerIds = ["@system/gmail", "@system/clickup"];

  beforeEach(async () => {
    await truncateAll();
    const { id } = await createTestUser();
    userId = id;
    const { org, defaultAppId } = await createTestOrg(userId);
    orgId = org.id;
    appId = defaultAppId;
    actor = { type: "member", id: userId };

    // Seed provider packages + enable them
    for (const pid of providerIds) {
      await seedPackage({
        orgId: null,
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
      await db.insert(applicationProviderCredentials).values({
        applicationId: appId,
        providerId: pid,
        credentialsEncrypted: "{}",
        enabled: true,
      });
    }

    // Default profile + connections for both providers
    defaultProfileId = await getDefaultProfileId(actor);
    for (const pid of providerIds) {
      await seedConnectionForApp(defaultProfileId, pid, orgId, appId, { api_key: "default-key" });
    }

    // Alt profile + connection for gmail only
    const alt = await seedConnectionProfile({ userId, name: "Alt" });
    altProfileId = alt.id;
    await seedConnectionForApp(altProfileId, "@system/gmail", orgId, appId, { api_key: "alt-key" });
  });

  async function seedAgentWithProviders(agentId: string) {
    await seedAgent({
      id: agentId,
      orgId,
      createdBy: userId,
      draftManifest: {
        name: agentId,
        version: "0.1.0",
        type: "agent",
        description: "Test",
        dependencies: {
          providers: Object.fromEntries(providerIds.map((id) => [id, "*"])),
        },
      },
    });
    return (await getPackage(agentId, orgId))!;
  }

  /** Inline preflight: resolve profiles, config, and validate readiness. */
  async function runPreflight(params: {
    agent: LoadedPackage;
    packageId: string;
    orgId: string;
    applicationId: string;
    defaultUserProfileId: string | null;
    userProviderOverrides?: Record<string, string>;
    appProfileId?: string | null;
  }): Promise<{
    providerProfiles: ProviderProfileMap;
    config: Record<string, unknown>;
    modelId: string | null;
    proxyId: string | null;
  }> {
    const {
      agent,
      packageId,
      orgId: oid,
      applicationId: aid,
      defaultUserProfileId,
      userProviderOverrides,
      appProfileId,
    } = params;
    const manifestProviders = resolveManifestProviders(agent.manifest);

    const [providerProfiles, packageConfig] = await Promise.all([
      resolveProviderProfiles(
        manifestProviders,
        defaultUserProfileId,
        userProviderOverrides,
        appProfileId,
        aid,
      ),
      getPackageConfig(aid, packageId),
    ]);

    await validateAgentReadiness({
      agent: agent,
      providerProfiles,
      orgId: oid,
      config: packageConfig.config,
      applicationId: aid,
    });

    return {
      providerProfiles,
      config: packageConfig.config,
      modelId: packageConfig.modelId,
      proxyId: packageConfig.proxyId,
    };
  }

  it("uses default profile for all providers when no overrides", async () => {
    const agentId = "@testorg/preflight-default";
    const agent = await seedAgentWithProviders(agentId);

    const { providerProfiles } = await runPreflight({
      agent,
      packageId: agentId,
      orgId,
      applicationId: appId,
      defaultUserProfileId: defaultProfileId,
    });

    expect(providerProfiles["@system/gmail"]!.profileId).toBe(defaultProfileId);
    expect(providerProfiles["@system/gmail"]!.source).toBe("user_profile");
    expect(providerProfiles["@system/clickup"]!.profileId).toBe(defaultProfileId);
    expect(providerProfiles["@system/clickup"]!.source).toBe("user_profile");
  });

  it("applies per-provider override for a specific provider", async () => {
    const agentId = "@testorg/preflight-override";
    const agent = await seedAgentWithProviders(agentId);

    const { providerProfiles } = await runPreflight({
      agent,
      packageId: agentId,
      orgId,
      applicationId: appId,
      defaultUserProfileId: defaultProfileId,
      userProviderOverrides: { "@system/gmail": altProfileId },
    });

    expect(providerProfiles["@system/gmail"]!.profileId).toBe(altProfileId);
    expect(providerProfiles["@system/gmail"]!.source).toBe("user_profile");
    expect(providerProfiles["@system/clickup"]!.profileId).toBe(defaultProfileId);
  });

  it("org binding takes priority over per-provider override", async () => {
    const agentId = "@testorg/preflight-org";
    const agent = await seedAgentWithProviders(agentId);

    // Create app profile + bind gmail to alt profile
    const appProfile = await seedConnectionProfile({ applicationId: appId, name: "App" });
    await bindAppProfileProvider(appProfile.id, "@system/gmail", altProfileId, userId);

    const { providerProfiles } = await runPreflight({
      agent,
      packageId: agentId,
      orgId,
      applicationId: appId,
      defaultUserProfileId: defaultProfileId,
      userProviderOverrides: { "@system/gmail": defaultProfileId },
      appProfileId: appProfile.id,
    });

    expect(providerProfiles["@system/gmail"]!.profileId).toBe(altProfileId);
    expect(providerProfiles["@system/gmail"]!.source).toBe("app_binding");
    // clickup not bound in app profile -> falls back to user override or default
    expect(providerProfiles["@system/clickup"]!.profileId).toBe(defaultProfileId);
    expect(providerProfiles["@system/clickup"]!.source).toBe("user_profile");
  });

  it("unbound provider uses per-provider override even with org profile", async () => {
    const agentId = "@testorg/preflight-mixed";
    const agent = await seedAgentWithProviders(agentId);

    const appProfile = await seedConnectionProfile({ applicationId: appId, name: "App" });
    // Only bind gmail, NOT clickup
    await bindAppProfileProvider(appProfile.id, "@system/gmail", altProfileId, userId);

    // Provide override for clickup
    await seedConnectionForApp(altProfileId, "@system/clickup", orgId, appId, {
      api_key: "alt-cu",
    });

    const { providerProfiles } = await runPreflight({
      agent,
      packageId: agentId,
      orgId,
      applicationId: appId,
      defaultUserProfileId: defaultProfileId,
      userProviderOverrides: { "@system/clickup": altProfileId },
      appProfileId: appProfile.id,
    });

    expect(providerProfiles["@system/gmail"]!.source).toBe("app_binding");
    expect(providerProfiles["@system/clickup"]!.profileId).toBe(altProfileId);
    expect(providerProfiles["@system/clickup"]!.source).toBe("user_profile");
  });
});
