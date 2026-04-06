// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import {
  seedConnectionProfile,
  seedAgent,
  seedPackage,
  seedConnectionForApp,
} from "../../helpers/seed.ts";
import { applicationProviderCredentials } from "@appstrate/db/schema";
import {
  resolveProviderProfiles,
  getDefaultProfileId,
  resolveActorProfileContext,
  setUserAgentProviderOverride,
} from "../../../src/services/connection-profiles.ts";
import { bindOrgProfileProvider } from "../../../src/services/state/org-profile-bindings.ts";
import {
  updateInstalledPackage,
  installPackage,
} from "../../../src/services/application-packages.ts";
import { resolveManifestProviders } from "../../../src/lib/manifest-utils.ts";
import { getPackageConfig } from "../../../src/services/application-packages.ts";
import { validateAgentReadiness } from "../../../src/services/agent-readiness.ts";
import { getPackage } from "../../../src/services/agent-service.ts";
import type { Actor } from "../../../src/lib/actor.ts";
import type {
  AgentProviderRequirement,
  LoadedPackage,
  ProviderProfileMap,
} from "../../../src/types/index.ts";

describe("Run with provider profiles", () => {
  let userId: string;
  let orgId: string;
  let appId: string;
  let actor: Actor;
  let defaultProfileId: string;

  const providerIds = ["@system/gmail", "@system/clickup", "@system/notion"];

  beforeEach(async () => {
    await truncateAll();
    const { id } = await createTestUser();
    userId = id;
    const { org, defaultAppId } = await createTestOrg(userId);
    orgId = org.id;
    appId = defaultAppId;
    actor = { type: "member", id: userId };

    // Seed provider packages + enable them for the org
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

    // Ensure default profile + connections
    defaultProfileId = await getDefaultProfileId(actor);
    for (const pid of providerIds) {
      await seedConnectionForApp(defaultProfileId, pid, orgId, appId, { api_key: "default-key" });
    }
  });

  function makeProviders(ids: string[]): AgentProviderRequirement[] {
    return ids.map((id) => ({ id, version: "*" }));
  }

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
    orgProfileId?: string | null;
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
      orgProfileId,
    } = params;
    const manifestProviders = resolveManifestProviders(agent.manifest);

    const [providerProfiles, packageConfig] = await Promise.all([
      resolveProviderProfiles(
        manifestProviders,
        defaultUserProfileId,
        userProviderOverrides,
        orgProfileId,
        oid,
      ),
      getPackageConfig(aid, packageId),
    ]);

    await validateAgentReadiness({
      agent: agent,
      providerProfiles,
      orgId: oid,
      applicationId: aid,
      config: packageConfig.config,
    });

    return {
      providerProfiles,
      config: packageConfig.config,
      modelId: packageConfig.modelId,
      proxyId: packageConfig.proxyId,
    };
  }

  describe("resolveProviderProfiles", () => {
    it("uses per-provider overrides from user_agent_provider_profiles", async () => {
      const altProfile = await seedConnectionProfile({ userId, name: "Alt Gmail" });
      await seedConnectionForApp(altProfile.id, "@system/gmail", orgId, appId, {
        api_key: "alt-key",
      });

      const providers = makeProviders(["@system/gmail", "@system/clickup"]);

      const map = await resolveProviderProfiles(
        providers,
        defaultProfileId,
        { "@system/gmail": altProfile.id },
        undefined,
        orgId,
      );

      expect(map["@system/gmail"]!.profileId).toBe(altProfile.id);
      expect(map["@system/gmail"]!.source).toBe("user_profile");
      expect(map["@system/clickup"]!.profileId).toBe(defaultProfileId);
      expect(map["@system/clickup"]!.source).toBe("user_profile");
    });

    it("uses org profile bindings when orgProfileId is provided", async () => {
      const orgProfile = await seedConnectionProfile({ orgId, name: "Org Profile" });
      const altProfile = await seedConnectionProfile({ userId, name: "Bound Source" });
      await seedConnectionForApp(altProfile.id, "@system/gmail", orgId, appId, {
        api_key: "org-key",
      });

      await bindOrgProfileProvider(orgProfile.id, "@system/gmail", altProfile.id, userId);

      const providers = makeProviders(["@system/gmail", "@system/clickup"]);

      const map = await resolveProviderProfiles(
        providers,
        defaultProfileId,
        {},
        orgProfile.id,
        orgId,
      );

      // gmail is bound in org profile -> uses org binding
      expect(map["@system/gmail"]!.profileId).toBe(altProfile.id);
      expect(map["@system/gmail"]!.source).toBe("org_binding");
      // clickup is not bound -> falls back to default
      expect(map["@system/clickup"]!.profileId).toBe(defaultProfileId);
      expect(map["@system/clickup"]!.source).toBe("user_profile");
    });

    it("falls back to default user profile when no overrides and no org profile", async () => {
      const providers = makeProviders(providerIds);

      const map = await resolveProviderProfiles(
        providers,
        defaultProfileId,
        undefined,
        undefined,
        orgId,
      );

      for (const pid of providerIds) {
        expect(map[pid]!.profileId).toBe(defaultProfileId);
        expect(map[pid]!.source).toBe("user_profile");
      }
    });

    it("org binding takes priority over per-provider user override", async () => {
      const userOverrideProfile = await seedConnectionProfile({ userId, name: "User Override" });
      const orgBoundProfile = await seedConnectionProfile({ userId, name: "Org Bound" });
      const orgProfile = await seedConnectionProfile({ orgId, name: "Org Profile" });

      await seedConnectionForApp(userOverrideProfile.id, "@system/gmail", orgId, appId, {
        api_key: "u",
      });
      await seedConnectionForApp(orgBoundProfile.id, "@system/gmail", orgId, appId, {
        api_key: "o",
      });

      await bindOrgProfileProvider(orgProfile.id, "@system/gmail", orgBoundProfile.id, userId);

      const providers = makeProviders(["@system/gmail"]);

      const map = await resolveProviderProfiles(
        providers,
        defaultProfileId,
        { "@system/gmail": userOverrideProfile.id },
        orgProfile.id,
        orgId,
      );

      // Org binding wins over user override
      expect(map["@system/gmail"]!.profileId).toBe(orgBoundProfile.id);
      expect(map["@system/gmail"]!.source).toBe("org_binding");
    });

    it("handles multiple providers with mixed org bindings and user overrides", async () => {
      const orgProfile = await seedConnectionProfile({ orgId, name: "Mixed Org" });
      const gmailBound = await seedConnectionProfile({ userId, name: "Gmail Bound" });
      const notionOverride = await seedConnectionProfile({ userId, name: "Notion Override" });

      await seedConnectionForApp(gmailBound.id, "@system/gmail", orgId, appId, { api_key: "g" });
      await seedConnectionForApp(notionOverride.id, "@system/notion", orgId, appId, {
        api_key: "n",
      });

      // Bind gmail in org profile
      await bindOrgProfileProvider(orgProfile.id, "@system/gmail", gmailBound.id, userId);

      const providers = makeProviders(["@system/gmail", "@system/clickup", "@system/notion"]);

      const map = await resolveProviderProfiles(
        providers,
        defaultProfileId,
        { "@system/notion": notionOverride.id },
        orgProfile.id,
        orgId,
      );

      // gmail: org binding
      expect(map["@system/gmail"]!.profileId).toBe(gmailBound.id);
      expect(map["@system/gmail"]!.source).toBe("org_binding");
      // clickup: no org binding, no user override -> default
      expect(map["@system/clickup"]!.profileId).toBe(defaultProfileId);
      expect(map["@system/clickup"]!.source).toBe("user_profile");
      // notion: no org binding, but has user override
      expect(map["@system/notion"]!.profileId).toBe(notionOverride.id);
      expect(map["@system/notion"]!.source).toBe("user_profile");
    });

    it("returns empty map when no providers are required", async () => {
      const map = await resolveProviderProfiles([], defaultProfileId, undefined, undefined, orgId);
      expect(map).toEqual({});
    });
  });

  describe("resolveActorProfileContext", () => {
    it("returns default profile and overrides for an actor", async () => {
      const altProfile = await seedConnectionProfile({ userId, name: "Alt" });
      const agent = await seedAgent({ id: "@testorg/ctx-agent", orgId, createdBy: userId });

      await setUserAgentProviderOverride(actor, agent.id, "@system/gmail", altProfile.id);

      const ctx = await resolveActorProfileContext(actor, agent.id);

      expect(ctx.defaultUserProfileId).toBe(defaultProfileId);
      expect(ctx.userProviderOverrides["@system/gmail"]).toBe(altProfile.id);
    });

    it("returns fallback profile when actor is null", async () => {
      const fallbackId = defaultProfileId;
      const agent = await seedAgent({ id: "@testorg/null-actor", orgId, createdBy: userId });

      const ctx = await resolveActorProfileContext(null, agent.id, fallbackId);

      expect(ctx.defaultUserProfileId).toBe(fallbackId);
      expect(ctx.userProviderOverrides).toEqual({});
    });
  });

  describe("full preflight with org profile on agent config", () => {
    it("reads orgProfileId from application_packages and applies org bindings", async () => {
      const agentId = "@testorg/preflight-config";
      const agent = await seedAgentWithProviders(agentId);

      const orgProfile = await seedConnectionProfile({ orgId, name: "Configured Org" });
      const boundProfile = await seedConnectionProfile({ userId, name: "Bound" });
      await seedConnectionForApp(boundProfile.id, "@system/gmail", orgId, appId, { api_key: "b" });

      await bindOrgProfileProvider(orgProfile.id, "@system/gmail", boundProfile.id, userId);

      // Install the agent in the application, then set org profile
      await installPackage(appId, orgId, agentId);
      await updateInstalledPackage(appId, agentId, { orgProfileId: orgProfile.id });

      const { providerProfiles } = await runPreflight({
        agent,
        packageId: agentId,
        orgId,
        applicationId: appId,
        defaultUserProfileId: defaultProfileId,
        orgProfileId: orgProfile.id,
      });

      expect(providerProfiles["@system/gmail"]!.profileId).toBe(boundProfile.id);
      expect(providerProfiles["@system/gmail"]!.source).toBe("org_binding");
      // Other providers fall back to default
      expect(providerProfiles["@system/clickup"]!.profileId).toBe(defaultProfileId);
      expect(providerProfiles["@system/notion"]!.profileId).toBe(defaultProfileId);
    });

    it("falls back to user defaults when org profile has no bindings", async () => {
      const agentId = "@testorg/preflight-empty-org";
      const agent = await seedAgentWithProviders(agentId);

      // Create org profile with no bindings
      const orgProfile = await seedConnectionProfile({ orgId, name: "Empty Org" });
      await installPackage(appId, orgId, agentId);
      await updateInstalledPackage(appId, agentId, { orgProfileId: orgProfile.id });

      const { providerProfiles } = await runPreflight({
        agent,
        packageId: agentId,
        orgId,
        applicationId: appId,
        defaultUserProfileId: defaultProfileId,
        orgProfileId: orgProfile.id,
      });

      // All providers fall back to user default
      for (const pid of providerIds) {
        expect(providerProfiles[pid]!.profileId).toBe(defaultProfileId);
        expect(providerProfiles[pid]!.source).toBe("user_profile");
      }
    });
  });
});
