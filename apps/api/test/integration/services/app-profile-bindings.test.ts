// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { userProviderConnections, applicationProviderCredentials } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import {
  seedConnectionProfile,
  seedConnectionForApp,
  seedApplication,
} from "../../helpers/seed.ts";
import {
  getAppProfileBindings,
  getAppProfileBindingsEnriched,
  bindAppProfileProvider,
  unbindAppProfileProvider,
} from "../../../src/services/state/app-profile-bindings.ts";

describe("app-profile-bindings", () => {
  let userId: string;
  let orgId: string;
  let defaultAppId: string;
  let appProfileId: string;
  let userProfileId: string;

  beforeEach(async () => {
    await truncateAll();
    const { id } = await createTestUser({ name: "Test User" });
    userId = id;
    const { org, defaultAppId: applicationId } = await createTestOrg(userId);
    orgId = org.id;
    defaultAppId = applicationId;

    const appProfile = await seedConnectionProfile({
      applicationId: defaultAppId,
      name: "App Profile",
    });
    appProfileId = appProfile.id;

    const userProfile = await seedConnectionProfile({ userId, name: "User Profile" });
    userProfileId = userProfile.id;
  });

  describe("getAppProfileBindings", () => {
    it("returns empty map when no bindings exist", async () => {
      const bindings = await getAppProfileBindings(appProfileId, defaultAppId);
      expect(bindings).toEqual({});
    });

    it("returns providerId to sourceProfileId map", async () => {
      await bindAppProfileProvider(appProfileId, "@test/gmail", userProfileId, userId);

      const bindings = await getAppProfileBindings(appProfileId, defaultAppId);
      expect(bindings).toEqual({ "@test/gmail": userProfileId });
    });
  });

  describe("getAppProfileBindingsEnriched", () => {
    it("returns connected true when source user has active connection", async () => {
      await bindAppProfileProvider(appProfileId, "@test/gmail", userProfileId, userId);
      await seedConnectionForApp(userProfileId, "@test/gmail", orgId, defaultAppId, {
        access_token: "tok",
      });

      const enriched = await getAppProfileBindingsEnriched(appProfileId, defaultAppId);
      expect(enriched).toHaveLength(1);
      const e0 = enriched[0]!;
      expect(e0.providerId).toBe("@test/gmail");
      expect(e0.sourceProfileId).toBe(userProfileId);
      expect(e0.sourceProfileName).toBe("User Profile");
      expect(e0.boundByUserName).toBe("Test User");
      expect(e0.connected).toBe(true);
    });

    it("returns connected false when source user has no connection", async () => {
      await bindAppProfileProvider(appProfileId, "@test/gmail", userProfileId, userId);

      const enriched = await getAppProfileBindingsEnriched(appProfileId, defaultAppId);
      expect(enriched).toHaveLength(1);
      expect(enriched[0]!.connected).toBe(false);
    });

    it("returns empty array when no bindings exist", async () => {
      const enriched = await getAppProfileBindingsEnriched(appProfileId, defaultAppId);
      expect(enriched).toEqual([]);
    });

    it("deduplicates when user has connections from multiple apps", async () => {
      // Bind gmail on the app profile
      await bindAppProfileProvider(appProfileId, "@test/gmail", userProfileId, userId);

      // Create connection from the default app
      await seedConnectionForApp(userProfileId, "@test/gmail", orgId, defaultAppId, {
        access_token: "tok-app1",
      });

      // Create a second app and connection for the same (profile, provider)
      const { id: secondAppId } = await seedApplication({ orgId, name: "Second App" });
      await seedConnectionForApp(userProfileId, "@test/gmail", orgId, secondAppId, {
        access_token: "tok-app2",
      });

      // The LEFT JOIN would produce 2 rows without dedup
      const enriched = await getAppProfileBindingsEnriched(appProfileId, defaultAppId);
      expect(enriched).toHaveLength(1); // NOT 2
      expect(enriched[0]!.providerId).toBe("@test/gmail");
      expect(enriched[0]!.connected).toBe(true);
    });

    it("shows connected when one app has healthy connection and another needs reconnection", async () => {
      await bindAppProfileProvider(appProfileId, "@test/gmail", userProfileId, userId);

      // App A: healthy connection
      await seedConnectionForApp(userProfileId, "@test/gmail", orgId, defaultAppId, {
        access_token: "tok-healthy",
      });

      // App B: connection that needs reconnection (won't match the LEFT JOIN filter)
      const { id: secondAppId } = await seedApplication({ orgId, name: "Second App" });
      await seedConnectionForApp(userProfileId, "@test/gmail", orgId, secondAppId, {
        access_token: "tok-broken",
      });

      // Find app B's credential and flag its connection as needing reconnection
      const [credB] = await db
        .select({ id: applicationProviderCredentials.id })
        .from(applicationProviderCredentials)
        .where(eq(applicationProviderCredentials.applicationId, secondAppId));
      await db
        .update(userProviderConnections)
        .set({ needsReconnection: true, updatedAt: new Date() })
        .where(
          and(
            eq(userProviderConnections.profileId, userProfileId),
            eq(userProviderConnections.providerId, "@test/gmail"),
            eq(userProviderConnections.providerCredentialId, credB!.id),
          ),
        );

      // The LEFT JOIN produces 2 rows: one with connectionId (healthy), one without (broken).
      // ORDER BY ... NULLS LAST ensures the healthy row wins the dedup.
      const enriched = await getAppProfileBindingsEnriched(appProfileId, defaultAppId);
      expect(enriched).toHaveLength(1);
      expect(enriched[0]!.connected).toBe(true);
    });
  });

  describe("bindAppProfileProvider", () => {
    it("upserts on same provider and updates sourceProfileId", async () => {
      const profile2 = await seedConnectionProfile({ userId, name: "Profile 2" });

      await bindAppProfileProvider(appProfileId, "@test/gmail", userProfileId, userId);
      await bindAppProfileProvider(appProfileId, "@test/gmail", profile2.id, userId);

      const bindings = await getAppProfileBindings(appProfileId, defaultAppId);
      expect(bindings["@test/gmail"]).toBe(profile2.id);
    });
  });

  describe("unbindAppProfileProvider", () => {
    it("removes the binding", async () => {
      await bindAppProfileProvider(appProfileId, "@test/gmail", userProfileId, userId);
      await unbindAppProfileProvider(appProfileId, "@test/gmail");

      const bindings = await getAppProfileBindings(appProfileId, defaultAppId);
      expect(bindings).toEqual({});
    });

    it("is idempotent when no binding exists", async () => {
      await unbindAppProfileProvider(appProfileId, "@test/nonexistent");
      // No throw
    });
  });
});
