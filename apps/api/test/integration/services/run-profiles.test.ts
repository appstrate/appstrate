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
  setMemberApplicationProfileId,
} from "../../../src/services/connection-profiles.ts";
import { bindAppProfileProvider } from "../../../src/services/state/app-profile-bindings.ts";
import {
  updateInstalledPackage,
  installPackage,
} from "../../../src/services/application-packages.ts";
import { resolveManifestProviders } from "../../../src/lib/manifest-utils.ts";
import { getPackageConfig } from "../../../src/services/application-packages.ts";
import { validateAgentReadiness } from "../../../src/services/agent-readiness.ts";
import { getPackage } from "../../../src/services/package-catalog.ts";
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
    actor = { type: "user", id: userId };

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

    it("uses app profile bindings when appProfileId is provided", async () => {
      const appProfile = await seedConnectionProfile({ applicationId: appId, name: "App Profile" });
      const altProfile = await seedConnectionProfile({ userId, name: "Bound Source" });
      await seedConnectionForApp(altProfile.id, "@system/gmail", orgId, appId, {
        api_key: "org-key",
      });

      await bindAppProfileProvider(appProfile.id, "@system/gmail", altProfile.id, userId);

      const providers = makeProviders(["@system/gmail", "@system/clickup"]);

      const map = await resolveProviderProfiles(
        providers,
        defaultProfileId,
        {},
        appProfile.id,
        appId,
      );

      // gmail is bound in app profile -> uses app binding
      expect(map["@system/gmail"]!.profileId).toBe(altProfile.id);
      expect(map["@system/gmail"]!.source).toBe("app_binding");
      // clickup is not bound -> falls back to default
      expect(map["@system/clickup"]!.profileId).toBe(defaultProfileId);
      expect(map["@system/clickup"]!.source).toBe("user_profile");
    });

    it("falls back to default user profile when no overrides and no app profile", async () => {
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

    it("app binding takes priority over per-provider user override", async () => {
      const userOverrideProfile = await seedConnectionProfile({ userId, name: "User Override" });
      const appBoundProfile = await seedConnectionProfile({ userId, name: "App Bound" });
      const appProfile = await seedConnectionProfile({ applicationId: appId, name: "App Profile" });

      await seedConnectionForApp(userOverrideProfile.id, "@system/gmail", orgId, appId, {
        api_key: "u",
      });
      await seedConnectionForApp(appBoundProfile.id, "@system/gmail", orgId, appId, {
        api_key: "o",
      });

      await bindAppProfileProvider(appProfile.id, "@system/gmail", appBoundProfile.id, userId);

      const providers = makeProviders(["@system/gmail"]);

      const map = await resolveProviderProfiles(
        providers,
        defaultProfileId,
        { "@system/gmail": userOverrideProfile.id },
        appProfile.id,
        appId,
      );

      // App binding wins over user override
      expect(map["@system/gmail"]!.profileId).toBe(appBoundProfile.id);
      expect(map["@system/gmail"]!.source).toBe("app_binding");
    });

    it("handles multiple providers with mixed app bindings and user overrides", async () => {
      const appProfile = await seedConnectionProfile({ applicationId: appId, name: "Mixed App" });
      const gmailBound = await seedConnectionProfile({ userId, name: "Gmail Bound" });
      const notionOverride = await seedConnectionProfile({ userId, name: "Notion Override" });

      await seedConnectionForApp(gmailBound.id, "@system/gmail", orgId, appId, { api_key: "g" });
      await seedConnectionForApp(notionOverride.id, "@system/notion", orgId, appId, {
        api_key: "n",
      });

      // Bind gmail in app profile
      await bindAppProfileProvider(appProfile.id, "@system/gmail", gmailBound.id, userId);

      const providers = makeProviders(["@system/gmail", "@system/clickup", "@system/notion"]);

      const map = await resolveProviderProfiles(
        providers,
        defaultProfileId,
        { "@system/notion": notionOverride.id },
        appProfile.id,
        appId,
      );

      // gmail: app binding
      expect(map["@system/gmail"]!.profileId).toBe(gmailBound.id);
      expect(map["@system/gmail"]!.source).toBe("app_binding");
      // clickup: no app binding, no user override -> default
      expect(map["@system/clickup"]!.profileId).toBe(defaultProfileId);
      expect(map["@system/clickup"]!.source).toBe("user_profile");
      // notion: no app binding, but has user override
      expect(map["@system/notion"]!.profileId).toBe(notionOverride.id);
      expect(map["@system/notion"]!.source).toBe("user_profile");
    });

    it("returns empty map when no providers are required", async () => {
      const map = await resolveProviderProfiles([], defaultProfileId, undefined, undefined, appId);
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

    it("sticky default beats auto-created Default when applicationId is supplied", async () => {
      // Mirrors the credential-proxy.ts:resolveProfileId cascade — sticky wins
      // over the member's auto-created Default profile so dashboard preflight
      // stays consistent with what the sidecar actually uses at run time.
      const work = await seedConnectionProfile({ userId, name: "Work" });
      const agent = await seedAgent({ id: "@testorg/sticky-agent", orgId, createdBy: userId });
      await setMemberApplicationProfileId(userId, appId, work.id);

      const ctx = await resolveActorProfileContext(actor, agent.id, null, appId);

      expect(ctx.defaultUserProfileId).toBe(work.id);
    });

    it("falls back to auto-created Default when no sticky is set", async () => {
      const agent = await seedAgent({ id: "@testorg/no-sticky", orgId, createdBy: userId });

      const ctx = await resolveActorProfileContext(actor, agent.id, null, appId);

      expect(ctx.defaultUserProfileId).toBe(defaultProfileId);
    });
  });

  describe("full preflight with app profile on agent config", () => {
    it("reads appProfileId from application_packages and applies app bindings", async () => {
      const agentId = "@testorg/preflight-config";
      const agent = await seedAgentWithProviders(agentId);

      const appProfile = await seedConnectionProfile({
        applicationId: appId,
        name: "Configured App",
      });
      const boundProfile = await seedConnectionProfile({ userId, name: "Bound" });
      await seedConnectionForApp(boundProfile.id, "@system/gmail", orgId, appId, { api_key: "b" });

      await bindAppProfileProvider(appProfile.id, "@system/gmail", boundProfile.id, userId);

      // Install the agent in the application, then set app profile
      await installPackage({ orgId: orgId, applicationId: appId }, agentId);
      await updateInstalledPackage({ orgId, applicationId: appId }, agentId, {
        appProfileId: appProfile.id,
      });

      const { providerProfiles } = await runPreflight({
        agent,
        packageId: agentId,
        orgId,
        applicationId: appId,
        defaultUserProfileId: defaultProfileId,
        appProfileId: appProfile.id,
      });

      expect(providerProfiles["@system/gmail"]!.profileId).toBe(boundProfile.id);
      expect(providerProfiles["@system/gmail"]!.source).toBe("app_binding");
      // Other providers fall back to default
      expect(providerProfiles["@system/clickup"]!.profileId).toBe(defaultProfileId);
      expect(providerProfiles["@system/notion"]!.profileId).toBe(defaultProfileId);
    });

    it("falls back to user defaults when app profile has no bindings", async () => {
      const agentId = "@testorg/preflight-empty-app";
      const agent = await seedAgentWithProviders(agentId);

      // Create app profile with no bindings
      const appProfile = await seedConnectionProfile({ applicationId: appId, name: "Empty App" });
      await installPackage({ orgId: orgId, applicationId: appId }, agentId);
      await updateInstalledPackage({ orgId, applicationId: appId }, agentId, {
        appProfileId: appProfile.id,
      });

      const { providerProfiles } = await runPreflight({
        agent,
        packageId: agentId,
        orgId,
        applicationId: appId,
        defaultUserProfileId: defaultProfileId,
        appProfileId: appProfile.id,
      });

      // All providers fall back to user default
      for (const pid of providerIds) {
        expect(providerProfiles[pid]!.profileId).toBe(defaultProfileId);
        expect(providerProfiles[pid]!.source).toBe("user_profile");
      }
    });
  });
});
