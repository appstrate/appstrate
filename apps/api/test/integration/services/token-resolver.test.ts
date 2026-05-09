// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedPackage, seedConnectionProfile, seedProviderCredentials } from "../../helpers/seed.ts";
import { saveConnection } from "@appstrate/connect";
import { buildProviderTokens } from "../../../src/services/token-resolver.ts";
import type { AgentProviderRequirement, ProviderProfileMap } from "../../../src/types/index.ts";

/** Helper to build a ProviderProfileMap from simple id → connectionProfileId pairs. */
function pm(entries: Record<string, string>): ProviderProfileMap {
  const map: ProviderProfileMap = {};
  for (const [id, pid] of Object.entries(entries)) {
    map[id] = { connectionProfileId: pid, source: "user_profile" };
  }
  return map;
}

describe("token-resolver", () => {
  let userId: string;
  let orgId: string;
  let defaultAppId: string;
  let connectionProfileId: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org, defaultAppId: applicationId } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    defaultAppId = applicationId;

    // Create a default connection profile for this user
    const profile = await seedConnectionProfile({ userId, name: "Default", isDefault: true });
    connectionProfileId = profile.id;
  });

  // ── Helper: seed a provider package with a definition ──────

  async function seedProvider(id: string, definition: Record<string, unknown>) {
    return seedPackage({
      orgId: null,
      id,
      type: "provider",
      source: "system",
      draftManifest: {
        name: id,
        version: "1.0.0",
        type: "provider",
        description: `Provider ${id}`,
        definition,
      },
    });
  }

  /** Seed a connection with auto-created provider credentials. */
  async function seedConnection(
    connProfileId: string,
    providerId: string,
    connOrgId: string,
    credentials: Record<string, unknown>,
    applicationId?: string,
  ) {
    const cred = await seedProviderCredentials({
      applicationId: applicationId ?? defaultAppId,
      providerId,
    });
    await saveConnection(db, connProfileId, providerId, connOrgId, credentials, {
      providerCredentialId: cred.id,
    });
  }

  // ── buildProviderTokens ─────────────────────────────────────

  describe("buildProviderTokens", () => {
    it("returns an empty map when no providers are required", async () => {
      const tokens = await buildProviderTokens([], {}, orgId, defaultAppId);

      expect(tokens).toEqual({});
    });

    it("returns an empty map when providers have no matching profiles", async () => {
      const providers: AgentProviderRequirement[] = [{ id: "@system/gmail" }];

      // providerProfiles is empty -- no profile assigned
      const tokens = await buildProviderTokens(providers, {}, orgId, defaultAppId);

      expect(tokens).toEqual({});
    });

    it("resolves access_token for an OAuth2 provider", async () => {
      const providerId = "@system/test-oauth";
      await seedProvider(providerId, {
        authMode: "api_key",
      });

      // Save a connection with an access_token
      await seedConnection(connectionProfileId, providerId, orgId, {
        access_token: "oauth-token-abc123",
        refresh_token: "refresh-xyz",
      });

      const providers: AgentProviderRequirement[] = [{ id: providerId }];
      const tokens = await buildProviderTokens(
        providers,
        pm({ [providerId]: connectionProfileId }),
        orgId,
        defaultAppId,
      );

      expect(tokens[providerId]).toBe("oauth-token-abc123");
    });

    it("resolves api_key when access_token is absent", async () => {
      const providerId = "@system/test-apikey";
      await seedProvider(providerId, {
        authMode: "api_key",
      });

      await seedConnection(connectionProfileId, providerId, orgId, {
        api_key: "key-secret-456",
      });

      const providers: AgentProviderRequirement[] = [{ id: providerId }];
      const tokens = await buildProviderTokens(
        providers,
        pm({ [providerId]: connectionProfileId }),
        orgId,
        defaultAppId,
      );

      expect(tokens[providerId]).toBe("key-secret-456");
    });

    it("prefers access_token over api_key when both are present", async () => {
      const providerId = "@system/test-both";
      await seedProvider(providerId, {
        authMode: "api_key",
      });

      await seedConnection(connectionProfileId, providerId, orgId, {
        access_token: "preferred-token",
        api_key: "fallback-key",
      });

      const providers: AgentProviderRequirement[] = [{ id: providerId }];
      const tokens = await buildProviderTokens(
        providers,
        pm({ [providerId]: connectionProfileId }),
        orgId,
        defaultAppId,
      );

      expect(tokens[providerId]).toBe("preferred-token");
    });

    it("uses __connected__ sentinel for custom auth with non-standard credentials", async () => {
      const providerId = "@system/test-custom";
      await seedProvider(providerId, {
        authMode: "custom",
        credentialSchema: {
          type: "object",
          properties: {
            username: { type: "string" },
            password: { type: "string" },
          },
        },
      });

      await seedConnection(connectionProfileId, providerId, orgId, {
        username: "admin",
        password: "secret",
      });

      const providers: AgentProviderRequirement[] = [{ id: providerId }];
      const tokens = await buildProviderTokens(
        providers,
        pm({ [providerId]: connectionProfileId }),
        orgId,
        defaultAppId,
      );

      expect(tokens[providerId]).toBe("__connected__");
    });

    it("uses __connected__ sentinel for basic auth", async () => {
      const providerId = "@system/test-basic";
      await seedProvider(providerId, {
        authMode: "basic",
      });

      await seedConnection(connectionProfileId, providerId, orgId, {
        username: "user",
        password: "pass",
      });

      const providers: AgentProviderRequirement[] = [{ id: providerId }];
      const tokens = await buildProviderTokens(
        providers,
        pm({ [providerId]: connectionProfileId }),
        orgId,
        defaultAppId,
      );

      expect(tokens[providerId]).toBe("__connected__");
    });

    it("skips providers whose connection is not found", async () => {
      const providerId = "@system/test-missing";
      await seedProvider(providerId, {
        authMode: "api_key",
      });

      // Credentials configured for the app, but no user connection saved
      await seedProviderCredentials({ applicationId: defaultAppId, providerId });

      const providers: AgentProviderRequirement[] = [{ id: providerId }];
      const tokens = await buildProviderTokens(
        providers,
        pm({ [providerId]: connectionProfileId }),
        orgId,
        defaultAppId,
      );

      expect(tokens[providerId]).toBeUndefined();
      expect(Object.keys(tokens)).toHaveLength(0);
    });

    it("throws when provider credential is not configured for the application", async () => {
      const providerId = "@system/test-no-cred";
      await seedProvider(providerId, { authMode: "api_key" });

      // No credentials seeded for defaultAppId — should throw

      const providers: AgentProviderRequirement[] = [{ id: providerId }];
      expect(
        buildProviderTokens(providers, pm({ [providerId]: connectionProfileId }), orgId, defaultAppId),
      ).rejects.toThrow("credential missing for application");
    });

    it("resolves multiple providers in a single call", async () => {
      const providerA = "@system/provider-a";
      const providerB = "@system/provider-b";
      const providerC = "@system/provider-c";

      await seedProvider(providerA, { authMode: "api_key" });
      await seedProvider(providerB, { authMode: "api_key" });
      await seedProvider(providerC, { authMode: "custom" });

      await seedConnection(connectionProfileId, providerA, orgId, {
        access_token: "token-a",
      });
      await seedConnection(connectionProfileId, providerB, orgId, {
        api_key: "key-b",
      });
      await seedConnection(connectionProfileId, providerC, orgId, {
        host: "example.com",
        token: "custom-c",
      });

      const providers: AgentProviderRequirement[] = [
        { id: providerA },
        { id: providerB },
        { id: providerC },
      ];
      const tokens = await buildProviderTokens(
        providers,
        pm({ [providerA]: connectionProfileId, [providerB]: connectionProfileId, [providerC]: connectionProfileId }),
        orgId,
        defaultAppId,
      );

      expect(Object.keys(tokens)).toHaveLength(3);
      expect(tokens[providerA]).toBe("token-a");
      expect(tokens[providerB]).toBe("key-b");
      expect(tokens[providerC]).toBe("__connected__");
    });

    it("only resolves providers that have a profile mapping", async () => {
      const providerMapped = "@system/mapped";
      const providerUnmapped = "@system/unmapped";

      await seedProvider(providerMapped, { authMode: "api_key" });
      await seedProvider(providerUnmapped, { authMode: "api_key" });

      await seedConnection(connectionProfileId, providerMapped, orgId, {
        api_key: "mapped-key",
      });
      await seedConnection(connectionProfileId, providerUnmapped, orgId, {
        api_key: "unmapped-key",
      });

      const providers: AgentProviderRequirement[] = [
        { id: providerMapped },
        { id: providerUnmapped },
      ];
      // Only providerMapped has a profile mapping
      const tokens = await buildProviderTokens(
        providers,
        pm({ [providerMapped]: connectionProfileId }),
        orgId,
        defaultAppId,
      );

      expect(tokens[providerMapped]).toBe("mapped-key");
      expect(tokens[providerUnmapped]).toBeUndefined();
      expect(Object.keys(tokens)).toHaveLength(1);
    });

    it("excludes providers with empty credentials object", async () => {
      const providerId = "@system/test-empty-creds";
      await seedProvider(providerId, {
        authMode: "custom",
      });

      // Save a connection with empty credentials
      await seedConnection(connectionProfileId, providerId, orgId, {});

      const providers: AgentProviderRequirement[] = [{ id: providerId }];
      const tokens = await buildProviderTokens(
        providers,
        pm({ [providerId]: connectionProfileId }),
        orgId,
        defaultAppId,
      );

      // No access_token, no api_key, and Object.keys(credentials).length === 0 → null → excluded
      expect(tokens[providerId]).toBeUndefined();
    });

    it("uses different profiles per provider", async () => {
      // Create a second connection profile
      const profile2 = await seedConnectionProfile({ userId, name: "Secondary" });
      const profileId2 = profile2.id;

      const providerA = "@system/diff-profile-a";
      const providerB = "@system/diff-profile-b";

      await seedProvider(providerA, { authMode: "api_key" });
      await seedProvider(providerB, { authMode: "api_key" });

      await seedConnection(connectionProfileId, providerA, orgId, {
        api_key: "key-from-profile-1",
      });
      await seedConnection(profileId2, providerB, orgId, {
        api_key: "key-from-profile-2",
      });

      const providers: AgentProviderRequirement[] = [{ id: providerA }, { id: providerB }];
      const tokens = await buildProviderTokens(
        providers,
        pm({ [providerA]: connectionProfileId, [providerB]: profileId2 }),
        orgId,
        defaultAppId,
      );

      expect(tokens[providerA]).toBe("key-from-profile-1");
      expect(tokens[providerB]).toBe("key-from-profile-2");
    });

    it("does not leak tokens across orgs", async () => {
      const otherUser = await createTestUser({ email: "other@test.com" });
      const { org: otherOrg, defaultAppId: otherAppId } = await createTestOrg(otherUser.id, {
        slug: "otherorg",
      });
      const otherProfile = await seedConnectionProfile({ userId: otherUser.id, name: "Other" });

      const providerId = "@system/cross-org";
      await seedProvider(providerId, { authMode: "api_key" });

      // Save connection in the OTHER org
      await seedConnection(
        otherProfile.id,
        providerId,
        otherOrg.id,
        {
          api_key: "other-org-secret",
        },
        otherAppId,
      );

      // Also configure credentials in our app so the credential lookup succeeds
      await seedProviderCredentials({ applicationId: defaultAppId, providerId });

      const providers: AgentProviderRequirement[] = [{ id: providerId }];
      // Try to resolve using our org but pointing to the other profile
      const tokens = await buildProviderTokens(
        providers,
        pm({ [providerId]: otherProfile.id }),
        orgId,
        defaultAppId,
      );

      // getCredentials filters by orgId, so the other org's connection should not resolve
      expect(tokens[providerId]).toBeUndefined();
    });
  });
});
