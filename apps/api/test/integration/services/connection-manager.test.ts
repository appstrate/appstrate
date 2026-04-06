// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedConnectionProfile, seedProviderCredentials, seedPackage } from "../../helpers/seed.ts";
import { userProviderConnections } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { decryptCredentials, encryptCredentials } from "@appstrate/connect";
import { authModeLabel } from "../../../src/services/connection-manager/helpers.ts";
import {
  saveApiKeyConnection,
  saveCredentialsConnection,
} from "../../../src/services/connection-manager/credentials.ts";
import {
  listActorConnections,
  disconnectProvider,
  disconnectConnectionById,
  deleteAllActorConnections,
} from "../../../src/services/connection-manager/operations.ts";
import type { Actor } from "../../../src/lib/actor.ts";

// ─── Helpers ──────────────────────────────────────────────

/** Insert a raw connection row for a profile + provider + org. */
async function seedConnection(
  profileId: string,
  providerId: string,
  orgId: string,
  appId: string,
): Promise<{ connectionId: string; credentialId: string }> {
  const encrypted = encryptCredentials({ test: "value" });
  // Ensure provider package exists (FK target for applicationProviderCredentials)
  const pkgId = providerId.startsWith("@") ? providerId : `@system/${providerId}`;
  await seedPackage({ orgId: null, id: pkgId, type: "provider", source: "system" }).catch(() => {});
  const cred = await seedProviderCredentials({ applicationId: appId, providerId: pkgId });

  const [row] = await db
    .insert(userProviderConnections)
    .values({
      profileId,
      providerId: pkgId,
      orgId,
      providerCredentialId: cred.id,
      credentialsEncrypted: encrypted,
      scopesGranted: [],
    })
    .returning();

  return { connectionId: row!.id, credentialId: cred.id };
}

// ─── Tests ────────────────────────────────────────────────

describe("connection-manager", () => {
  let userId: string;
  let orgId: string;
  let profileId: string;
  let applicationId: string;

  beforeEach(async () => {
    await truncateAll();
    const user = await createTestUser();
    userId = user.id;
    const { org, defaultAppId } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    applicationId = defaultAppId;

    const profile = await seedConnectionProfile({ userId, name: "Default", isDefault: true });
    profileId = profile.id;
  });

  // ── authModeLabel ─────────────────────────────────────

  describe("authModeLabel", () => {
    it("returns API_KEY for api_key mode", () => {
      expect(authModeLabel("api_key")).toBe("API_KEY");
    });

    it("returns OAUTH1 for oauth1 mode", () => {
      expect(authModeLabel("oauth1")).toBe("OAUTH1");
    });

    it("returns OAUTH2 for oauth2 mode", () => {
      expect(authModeLabel("oauth2")).toBe("OAUTH2");
    });

    it("returns OAUTH2 for undefined mode", () => {
      expect(authModeLabel(undefined)).toBe("OAUTH2");
    });

    it("returns OAUTH2 for unrecognized mode", () => {
      expect(authModeLabel("unknown")).toBe("OAUTH2");
    });
  });

  // ── saveApiKeyConnection ──────────────────────────────

  describe("saveApiKeyConnection", () => {
    it("stores an encrypted API key credential", async () => {
      await seedPackage({
        orgId: null,
        id: "@system/test-provider",
        type: "provider",
        source: "system",
      });
      await seedProviderCredentials({ applicationId, providerId: "@system/test-provider" });
      await saveApiKeyConnection(
        "@system/test-provider",
        "sk-test-key-12345",
        profileId,
        orgId,
        applicationId,
      );

      const rows = await db
        .select()
        .from(userProviderConnections)
        .where(eq(userProviderConnections.profileId, profileId));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.providerId).toBe("@system/test-provider");
      expect(rows[0]!.orgId).toBe(orgId);

      // Credential is encrypted (not plaintext)
      expect(rows[0]!.credentialsEncrypted).not.toContain("sk-test-key-12345");

      // Decrypts back to the original API key
      const decrypted = decryptCredentials<Record<string, string>>(rows[0]!.credentialsEncrypted);
      expect(decrypted.api_key).toBe("sk-test-key-12345");
    });

    it("upserts on same profile + provider + org", async () => {
      await seedPackage({
        orgId: null,
        id: "@system/test-provider",
        type: "provider",
        source: "system",
      });
      await seedProviderCredentials({ applicationId, providerId: "@system/test-provider" });
      await saveApiKeyConnection(
        "@system/test-provider",
        "key-v1",
        profileId,
        orgId,
        applicationId,
      );
      await saveApiKeyConnection(
        "@system/test-provider",
        "key-v2",
        profileId,
        orgId,
        applicationId,
      );

      const rows = await db
        .select()
        .from(userProviderConnections)
        .where(eq(userProviderConnections.profileId, profileId));

      expect(rows).toHaveLength(1);

      const decrypted = decryptCredentials<Record<string, string>>(rows[0]!.credentialsEncrypted);
      expect(decrypted.api_key).toBe("key-v2");
    });
  });

  // ── saveCredentialsConnection ─────────────────────────

  describe("saveCredentialsConnection", () => {
    it("stores encrypted basic credentials", async () => {
      await seedPackage({
        orgId: null,
        id: "@system/basic-provider",
        type: "provider",
        source: "system",
      });
      await seedProviderCredentials({ applicationId, providerId: "@system/basic-provider" });
      await saveCredentialsConnection(
        "@system/basic-provider",
        "basic",
        { username: "admin", password: "secret123" },
        profileId,
        orgId,
        applicationId,
      );

      const rows = await db
        .select()
        .from(userProviderConnections)
        .where(eq(userProviderConnections.profileId, profileId));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.providerId).toBe("@system/basic-provider");

      const decrypted = decryptCredentials<Record<string, string>>(rows[0]!.credentialsEncrypted);
      expect(decrypted.username).toBe("admin");
      expect(decrypted.password).toBe("secret123");
    });

    it("stores encrypted custom credentials", async () => {
      await seedPackage({
        orgId: null,
        id: "@system/custom-provider",
        type: "provider",
        source: "system",
      });
      await seedProviderCredentials({ applicationId, providerId: "@system/custom-provider" });
      await saveCredentialsConnection(
        "@system/custom-provider",
        "custom",
        { token: "abc", workspace_id: "ws-1" },
        profileId,
        orgId,
        applicationId,
      );

      const rows = await db
        .select()
        .from(userProviderConnections)
        .where(eq(userProviderConnections.profileId, profileId));

      expect(rows).toHaveLength(1);

      const decrypted = decryptCredentials<Record<string, string>>(rows[0]!.credentialsEncrypted);
      expect(decrypted.token).toBe("abc");
      expect(decrypted.workspace_id).toBe("ws-1");
    });
  });

  // ── listActorConnections ──────────────────────────────

  describe("listActorConnections", () => {
    it("returns connections for a profile", async () => {
      await seedConnection(profileId, "gmail", orgId, applicationId);
      await seedConnection(profileId, "clickup", orgId, applicationId);

      const connections = await listActorConnections(profileId, orgId);

      expect(connections).toHaveLength(2);
      const providers = connections.map((c) => c.provider);
      expect(providers).toContain("@system/gmail");
      expect(providers).toContain("@system/clickup");

      for (const conn of connections) {
        expect(conn.status).toBe("connected");
        expect(conn.connectionId).toBeDefined();
        expect(conn.connectedAt).toBeDefined();
      }
    });

    it("returns empty array for a profile with no connections", async () => {
      const connections = await listActorConnections(profileId, orgId);
      expect(connections).toBeArray();
      expect(connections).toHaveLength(0);
    });

    it("does not return connections from other profiles", async () => {
      const otherUser = await createTestUser({ email: "other@test.com" });
      const otherProfile = await seedConnectionProfile({
        userId: otherUser.id,
        name: "Other Profile",
      });

      await seedConnection(otherProfile.id, "gmail", orgId, applicationId);

      const connections = await listActorConnections(profileId, orgId);
      expect(connections).toHaveLength(0);
    });

    it("does not return connections from other orgs", async () => {
      const otherUser = await createTestUser({ email: "org2@test.com" });
      const { org: otherOrg, defaultAppId: otherAppId } = await createTestOrg(otherUser.id, {
        slug: "otherorg",
      });

      await seedConnection(profileId, "gmail", otherOrg.id, otherAppId);

      const connections = await listActorConnections(profileId, orgId);
      expect(connections).toHaveLength(0);
    });
  });

  // ── disconnectProvider ────────────────────────────────

  describe("disconnectProvider", () => {
    it("removes connection for the given provider", async () => {
      const gmail = await seedConnection(profileId, "gmail", orgId, applicationId);
      await seedConnection(profileId, "clickup", orgId, applicationId);

      await disconnectProvider("@system/gmail", profileId, orgId, gmail.credentialId);

      const connections = await listActorConnections(profileId, orgId);
      expect(connections).toHaveLength(1);
      expect(connections[0]!.provider).toBe("@system/clickup");
    });

    it("does not throw when provider has no connection", async () => {
      await disconnectProvider(
        "nonexistent",
        profileId,
        orgId,
        "00000000-0000-0000-0000-000000000000",
      );

      const connections = await listActorConnections(profileId, orgId);
      expect(connections).toHaveLength(0);
    });
  });

  // ── disconnectConnectionById ──────────────────────────

  describe("disconnectConnectionById", () => {
    it("removes a specific connection by ID", async () => {
      const { connectionId } = await seedConnection(profileId, "gmail", orgId, applicationId);
      await seedConnection(profileId, "clickup", orgId, applicationId);

      const actor: Actor = { type: "member", id: userId };
      await disconnectConnectionById(connectionId, actor);

      const connections = await listActorConnections(profileId, orgId);
      expect(connections).toHaveLength(1);
      expect(connections[0]!.provider).toBe("@system/clickup");
    });

    it("throws when connection does not belong to the actor", async () => {
      const { connectionId } = await seedConnection(profileId, "gmail", orgId, applicationId);

      const otherUser = await createTestUser({ email: "hacker@test.com" });
      const actor: Actor = { type: "member", id: otherUser.id };

      await expect(disconnectConnectionById(connectionId, actor)).rejects.toThrow(
        "Connection not found or not owned by actor",
      );
    });

    it("throws when connection ID does not exist", async () => {
      const actor: Actor = { type: "member", id: userId };
      const fakeId = "00000000-0000-0000-0000-000000000000";

      await expect(disconnectConnectionById(fakeId, actor)).rejects.toThrow(
        "Connection not found or not owned by actor",
      );
    });
  });

  // ── deleteAllActorConnections ─────────────────────────

  describe("deleteAllActorConnections", () => {
    it("removes all connections for the actor across all profiles", async () => {
      // Create a second profile for the same user
      const profile2 = await seedConnectionProfile({ userId, name: "Profile 2" });

      await seedConnection(profileId, "gmail", orgId, applicationId);
      await seedConnection(profileId, "clickup", orgId, applicationId);
      await seedConnection(profile2.id, "slack", orgId, applicationId);

      const actor: Actor = { type: "member", id: userId };
      await deleteAllActorConnections(actor);

      const conn1 = await listActorConnections(profileId, orgId);
      const conn2 = await listActorConnections(profile2.id, orgId);

      expect(conn1).toHaveLength(0);
      expect(conn2).toHaveLength(0);
    });

    it("does not remove connections belonging to other actors", async () => {
      const otherUser = await createTestUser({ email: "keep@test.com" });
      const { org: otherOrg, defaultAppId: otherAppId } = await createTestOrg(otherUser.id, {
        slug: "keeporg",
      });
      const otherProfile = await seedConnectionProfile({
        userId: otherUser.id,
        name: "Keep Profile",
      });

      await seedConnection(profileId, "gmail", orgId, applicationId);
      await seedConnection(otherProfile.id, "clickup", otherOrg.id, otherAppId);

      const actor: Actor = { type: "member", id: userId };
      await deleteAllActorConnections(actor);

      // Actor's connections are gone
      const actorConns = await listActorConnections(profileId, orgId);
      expect(actorConns).toHaveLength(0);

      // Other user's connections are intact
      const otherConns = await listActorConnections(otherProfile.id, otherOrg.id);
      expect(otherConns).toHaveLength(1);
      expect(otherConns[0]!.provider).toBe("@system/clickup");
    });

    it("is a no-op when actor has no profiles", async () => {
      const otherUser = await createTestUser({ email: "noprofile@test.com" });
      const actor: Actor = { type: "member", id: otherUser.id };

      // Should not throw
      await deleteAllActorConnections(actor);
    });
  });
});
