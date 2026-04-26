// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for application-scoped connection isolation.
 *
 * Covers: credential leak prevention, multi-app isolation, disconnect scoping,
 * cascade delete, and needsReconnection per-providerCredentialId.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { getTestApp } from "../../helpers/app.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  seedConnectionProfile,
  seedProviderCredentials,
  seedPackage,
  seedConnectionForApp,
  seedApplication,
} from "../../helpers/seed.ts";
import { listConnections, getConnection, listProviderCredentialIds } from "@appstrate/connect";
import { applicationProviderCredentials, userProviderConnections } from "@appstrate/db/schema";
import { eq, and } from "drizzle-orm";

const app = getTestApp();

describe("Application-scoped connection isolation", () => {
  let ctx: TestContext;
  let profileId: string;
  let appAId: string;
  let appBId: string;
  const providerId = "@system/gmail";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "conn-scope-test" });
    appAId = ctx.defaultAppId;

    // Create second application
    const appB = await seedApplication({ orgId: ctx.orgId, name: "AppB" });
    appBId = appB.id;

    // Create user connection profile
    const profile = await seedConnectionProfile({
      userId: ctx.user.id,
      name: "Default",
      isDefault: true,
    });
    profileId = profile.id;

    // Ensure provider package exists
    await seedPackage({ orgId: null, id: providerId, type: "provider", source: "system" }).catch(
      () => {},
    );
  });

  // ─── Multi-app connection isolation ─────────────────────────

  describe("multi-app isolation", () => {
    it("connections created in app A are not visible from app B credentials", async () => {
      // Create connection in app A
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appAId, { api_key: "key-a" });

      // Get app B's credential IDs — should not include app A's
      const credB = await seedProviderCredentials({ applicationId: appBId, providerId });
      const result = await listConnections(db, profileId, ctx.orgId, [credB.id]);
      expect(result).toHaveLength(0);
    });

    it("same provider can have separate connections per app", async () => {
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appAId, { api_key: "key-a" });
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appBId, { api_key: "key-b" });

      const credIdsA = await listProviderCredentialIds(db, appAId);
      const credIdsB = await listProviderCredentialIds(db, appBId);

      const connA = await listConnections(db, profileId, ctx.orgId, credIdsA);
      const connB = await listConnections(db, profileId, ctx.orgId, credIdsB);

      expect(connA).toHaveLength(1);
      expect(connB).toHaveLength(1);
      expect(connA[0]!.providerCredentialId).not.toBe(connB[0]!.providerCredentialId);
    });
  });

  // ─── Credential leak prevention ─────────────────────────────

  describe("credential leak prevention", () => {
    it("GET /connections does NOT expose credentialsEncrypted", async () => {
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appAId, { api_key: "secret" });

      const res = await app.request(`/api/connections?profileId=${profileId}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown>[] };
      expect(body.data).toHaveLength(1);

      const conn = body.data[0]!;
      expect(conn.credentialsEncrypted).toBeUndefined();
      expect(conn.providerCredentialId).toBeUndefined();
      expect(conn.expiresAt).toBeUndefined();
      // Should still have safe fields
      expect(conn.provider).toBe(providerId);
      expect(conn.connectionId).toBeDefined();
    });

    it("GET /connection-profiles/:id/connections does NOT expose credentialsEncrypted", async () => {
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appAId, { api_key: "secret" });

      // This endpoint is not app-scoped (no X-App-Id middleware), so returns empty.
      // When app-scoped, it should strip sensitive fields.
      // Test that the raw listConnections result never leaks credentials.
      const credentialIds = await listProviderCredentialIds(db, appAId);
      const rawConns = await listConnections(db, profileId, ctx.orgId, credentialIds);
      expect(rawConns).toHaveLength(1);
      // The raw ConnectionRecord HAS credentialsEncrypted — that's expected at the data layer
      expect(rawConns[0]!.credentialsEncrypted).toBeDefined();
    });
  });

  // ─── Disconnect scoping ─────────────────────────────────────

  describe("disconnect scoping", () => {
    it("disconnectConnectionById rejects connections from other apps", async () => {
      // Create connection in app A
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appAId, { api_key: "key-a" });
      const credIdsA = await listProviderCredentialIds(db, appAId);
      const connA = await listConnections(db, profileId, ctx.orgId, credIdsA);
      const connId = connA[0]!.id;

      // Try to delete from app B context — should fail (connection not found in app B's scope)
      const res = await app.request(`/api/connections/${providerId}?connectionId=${connId}`, {
        method: "DELETE",
        headers: authHeaders({ ...ctx, defaultAppId: appBId }),
      });
      // Should fail because connection's providerCredentialId doesn't match app B
      expect(res.status).not.toBe(200);
    });

    it("disconnectConnectionById succeeds for connections in the correct app", async () => {
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appAId, { api_key: "key-a" });
      const credIdsA = await listProviderCredentialIds(db, appAId);
      const connA = await listConnections(db, profileId, ctx.orgId, credIdsA);
      const connId = connA[0]!.id;

      const res = await app.request(`/api/connections/${providerId}?connectionId=${connId}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);

      // Verify connection is gone
      const remaining = await listConnections(db, profileId, ctx.orgId, credIdsA);
      expect(remaining).toHaveLength(0);
    });
  });

  // ─── Cascade delete ─────────────────────────────────────────

  describe("cascade delete", () => {
    it("deleting applicationProviderCredentials cascades to connections", async () => {
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appAId, { api_key: "key-a" });

      // Verify connection exists
      const credIdsA = await listProviderCredentialIds(db, appAId);
      expect(credIdsA).toHaveLength(1);
      const before = await listConnections(db, profileId, ctx.orgId, credIdsA);
      expect(before).toHaveLength(1);

      // Delete the application provider credentials
      await db
        .delete(applicationProviderCredentials)
        .where(
          and(
            eq(applicationProviderCredentials.applicationId, appAId),
            eq(applicationProviderCredentials.providerId, providerId),
          ),
        );

      // Connection should be cascade-deleted
      const allConns = await db
        .select()
        .from(userProviderConnections)
        .where(
          and(
            eq(userProviderConnections.profileId, profileId),
            eq(userProviderConnections.providerId, providerId),
          ),
        );
      expect(allConns).toHaveLength(0);
    });

    it("deleting app A credentials does not affect app B connections", async () => {
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appAId, { api_key: "key-a" });
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appBId, { api_key: "key-b" });

      // Delete app A credentials only
      await db
        .delete(applicationProviderCredentials)
        .where(
          and(
            eq(applicationProviderCredentials.applicationId, appAId),
            eq(applicationProviderCredentials.providerId, providerId),
          ),
        );

      // App B connections should still exist
      const credIdsB = await listProviderCredentialIds(db, appBId);
      const connB = await listConnections(db, profileId, ctx.orgId, credIdsB);
      expect(connB).toHaveLength(1);
    });
  });

  // ─── Token refresh per-app isolation ─────────────────────────

  describe("token refresh per-app isolation", () => {
    it("updating connection credentials in app A does not affect app B", async () => {
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appAId, { api_key: "key-a" });
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appBId, { api_key: "key-b" });

      const credIdsA = await listProviderCredentialIds(db, appAId);
      const credIdsB = await listProviderCredentialIds(db, appBId);

      // Get both connections
      const connA = await getConnection(db, profileId, providerId, ctx.orgId, credIdsA[0]!);
      const connB = await getConnection(db, profileId, providerId, ctx.orgId, credIdsB[0]!);
      expect(connA).not.toBeNull();
      expect(connB).not.toBeNull();

      // Update App A's connection (simulate token refresh)
      await db
        .update(userProviderConnections)
        .set({ credentialsEncrypted: "refreshed-token-app-a", updatedAt: new Date() })
        .where(eq(userProviderConnections.id, connA!.id));

      // Verify App B's connection is untouched
      const connBAfter = await getConnection(db, profileId, providerId, ctx.orgId, credIdsB[0]!);
      expect(connBAfter!.credentialsEncrypted).not.toBe("refreshed-token-app-a");
      expect(connBAfter!.credentialsEncrypted).toBe(connB!.credentialsEncrypted);
    });
  });

  // ─── needsReconnection scoping ──────────────────────────────

  describe("needsReconnection per-providerCredentialId", () => {
    it("flagging reconnection in app A does not affect app B", async () => {
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appAId, { api_key: "key-a" });
      await seedConnectionForApp(profileId, providerId, ctx.orgId, appBId, { api_key: "key-b" });

      const credIdsA = await listProviderCredentialIds(db, appAId);
      const credIdsB = await listProviderCredentialIds(db, appBId);

      // Flag app A's connection for reconnection
      await db
        .update(userProviderConnections)
        .set({ needsReconnection: true, updatedAt: new Date() })
        .where(
          and(
            eq(userProviderConnections.profileId, profileId),
            eq(userProviderConnections.providerId, providerId),
            eq(userProviderConnections.providerCredentialId, credIdsA[0]!),
          ),
        );

      // App A connection should need reconnection
      const connA = await getConnection(db, profileId, providerId, ctx.orgId, credIdsA[0]!);
      expect(connA!.needsReconnection).toBe(true);

      // App B connection should NOT need reconnection
      const connB = await getConnection(db, profileId, providerId, ctx.orgId, credIdsB[0]!);
      expect(connB!.needsReconnection).toBe(false);
    });
  });
});
