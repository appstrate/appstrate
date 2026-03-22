import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedPackage, seedConnectionProfile } from "../../helpers/seed.ts";
import { saveConnection } from "@appstrate/connect";
import { buildProviderTokens } from "../../../src/services/token-resolver.ts";
import type { FlowProviderRequirement } from "../../../src/types/index.ts";

describe("token-resolver", () => {
  let userId: string;
  let orgId: string;
  let orgSlug: string;
  let profileId: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    orgSlug = org.slug;

    // Create a default connection profile for this user
    const profile = await seedConnectionProfile({ userId, name: "Default", isDefault: true });
    profileId = profile.id;
  });

  // ── Helper: seed a provider package with a definition ──────

  async function seedProvider(
    id: string,
    definition: Record<string, unknown>,
  ) {
    return seedPackage({
      orgId: null as unknown as string,
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

  // ── buildProviderTokens ─────────────────────────────────────

  describe("buildProviderTokens", () => {
    it("returns an empty map when no providers are required", async () => {
      const tokens = await buildProviderTokens([], {}, orgId);

      expect(tokens).toEqual({});
    });

    it("returns an empty map when providers have no matching profiles", async () => {
      const providers: FlowProviderRequirement[] = [
        { id: "@system/gmail", provider: "gmail" },
      ];

      // providerProfiles is empty -- no profile assigned
      const tokens = await buildProviderTokens(providers, {}, orgId);

      expect(tokens).toEqual({});
    });

    it("resolves access_token for an OAuth2 provider", async () => {
      const providerId = "@system/test-oauth";
      await seedProvider(providerId, {
        authMode: "api_key",
      });

      // Save a connection with an access_token
      await saveConnection(db, profileId, providerId, orgId, {
        access_token: "oauth-token-abc123",
        refresh_token: "refresh-xyz",
      });

      const providers: FlowProviderRequirement[] = [
        { id: providerId, provider: "test-oauth" },
      ];
      const providerProfiles: Record<string, string> = {
        [providerId]: profileId,
      };

      const tokens = await buildProviderTokens(providers, providerProfiles, orgId);

      expect(tokens[providerId]).toBe("oauth-token-abc123");
    });

    it("resolves api_key when access_token is absent", async () => {
      const providerId = "@system/test-apikey";
      await seedProvider(providerId, {
        authMode: "api_key",
      });

      await saveConnection(db, profileId, providerId, orgId, {
        api_key: "key-secret-456",
      });

      const providers: FlowProviderRequirement[] = [
        { id: providerId, provider: "test-apikey" },
      ];
      const providerProfiles: Record<string, string> = {
        [providerId]: profileId,
      };

      const tokens = await buildProviderTokens(providers, providerProfiles, orgId);

      expect(tokens[providerId]).toBe("key-secret-456");
    });

    it("prefers access_token over api_key when both are present", async () => {
      const providerId = "@system/test-both";
      await seedProvider(providerId, {
        authMode: "api_key",
      });

      await saveConnection(db, profileId, providerId, orgId, {
        access_token: "preferred-token",
        api_key: "fallback-key",
      });

      const providers: FlowProviderRequirement[] = [
        { id: providerId, provider: "test-both" },
      ];
      const providerProfiles: Record<string, string> = {
        [providerId]: profileId,
      };

      const tokens = await buildProviderTokens(providers, providerProfiles, orgId);

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

      await saveConnection(db, profileId, providerId, orgId, {
        username: "admin",
        password: "secret",
      });

      const providers: FlowProviderRequirement[] = [
        { id: providerId, provider: "test-custom" },
      ];
      const providerProfiles: Record<string, string> = {
        [providerId]: profileId,
      };

      const tokens = await buildProviderTokens(providers, providerProfiles, orgId);

      expect(tokens[providerId]).toBe("__connected__");
    });

    it("uses __connected__ sentinel for basic auth", async () => {
      const providerId = "@system/test-basic";
      await seedProvider(providerId, {
        authMode: "basic",
      });

      await saveConnection(db, profileId, providerId, orgId, {
        username: "user",
        password: "pass",
      });

      const providers: FlowProviderRequirement[] = [
        { id: providerId, provider: "test-basic" },
      ];
      const providerProfiles: Record<string, string> = {
        [providerId]: profileId,
      };

      const tokens = await buildProviderTokens(providers, providerProfiles, orgId);

      expect(tokens[providerId]).toBe("__connected__");
    });

    it("skips providers whose connection is not found", async () => {
      const providerId = "@system/test-missing";
      await seedProvider(providerId, {
        authMode: "api_key",
      });

      // No connection saved for this provider -- getCredentials returns null

      const providers: FlowProviderRequirement[] = [
        { id: providerId, provider: "test-missing" },
      ];
      const providerProfiles: Record<string, string> = {
        [providerId]: profileId,
      };

      const tokens = await buildProviderTokens(providers, providerProfiles, orgId);

      expect(tokens[providerId]).toBeUndefined();
      expect(Object.keys(tokens)).toHaveLength(0);
    });

    it("resolves multiple providers in a single call", async () => {
      const providerA = "@system/provider-a";
      const providerB = "@system/provider-b";
      const providerC = "@system/provider-c";

      await seedProvider(providerA, { authMode: "api_key" });
      await seedProvider(providerB, { authMode: "api_key" });
      await seedProvider(providerC, { authMode: "custom" });

      await saveConnection(db, profileId, providerA, orgId, {
        access_token: "token-a",
      });
      await saveConnection(db, profileId, providerB, orgId, {
        api_key: "key-b",
      });
      await saveConnection(db, profileId, providerC, orgId, {
        host: "example.com",
        token: "custom-c",
      });

      const providers: FlowProviderRequirement[] = [
        { id: providerA, provider: "provider-a" },
        { id: providerB, provider: "provider-b" },
        { id: providerC, provider: "provider-c" },
      ];
      const providerProfiles: Record<string, string> = {
        [providerA]: profileId,
        [providerB]: profileId,
        [providerC]: profileId,
      };

      const tokens = await buildProviderTokens(providers, providerProfiles, orgId);

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

      await saveConnection(db, profileId, providerMapped, orgId, {
        api_key: "mapped-key",
      });
      await saveConnection(db, profileId, providerUnmapped, orgId, {
        api_key: "unmapped-key",
      });

      const providers: FlowProviderRequirement[] = [
        { id: providerMapped, provider: "mapped" },
        { id: providerUnmapped, provider: "unmapped" },
      ];
      // Only providerMapped has a profile mapping
      const providerProfiles: Record<string, string> = {
        [providerMapped]: profileId,
      };

      const tokens = await buildProviderTokens(providers, providerProfiles, orgId);

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
      await saveConnection(db, profileId, providerId, orgId, {});

      const providers: FlowProviderRequirement[] = [
        { id: providerId, provider: "test-empty-creds" },
      ];
      const providerProfiles: Record<string, string> = {
        [providerId]: profileId,
      };

      const tokens = await buildProviderTokens(providers, providerProfiles, orgId);

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

      await saveConnection(db, profileId, providerA, orgId, {
        api_key: "key-from-profile-1",
      });
      await saveConnection(db, profileId2, providerB, orgId, {
        api_key: "key-from-profile-2",
      });

      const providers: FlowProviderRequirement[] = [
        { id: providerA, provider: "diff-profile-a" },
        { id: providerB, provider: "diff-profile-b" },
      ];
      const providerProfiles: Record<string, string> = {
        [providerA]: profileId,
        [providerB]: profileId2,
      };

      const tokens = await buildProviderTokens(providers, providerProfiles, orgId);

      expect(tokens[providerA]).toBe("key-from-profile-1");
      expect(tokens[providerB]).toBe("key-from-profile-2");
    });

    it("does not leak tokens across orgs", async () => {
      const otherUser = await createTestUser({ email: "other@test.com" });
      const { org: otherOrg } = await createTestOrg(otherUser.id, { slug: "otherorg" });
      const otherProfile = await seedConnectionProfile({ userId: otherUser.id, name: "Other" });

      const providerId = "@system/cross-org";
      await seedProvider(providerId, { authMode: "api_key" });

      // Save connection in the OTHER org
      await saveConnection(db, otherProfile.id, providerId, otherOrg.id, {
        api_key: "other-org-secret",
      });

      const providers: FlowProviderRequirement[] = [
        { id: providerId, provider: "cross-org" },
      ];
      // Try to resolve using our org but pointing to the other profile
      const providerProfiles: Record<string, string> = {
        [providerId]: otherProfile.id,
      };

      const tokens = await buildProviderTokens(providers, providerProfiles, orgId);

      // getCredentials filters by orgId, so the other org's connection should not resolve
      expect(tokens[providerId]).toBeUndefined();
    });
  });
});
