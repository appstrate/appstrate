// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedConnectionProfile, seedConnectionForApp } from "../../helpers/seed.ts";
import {
  getOrgProfileBindings,
  getOrgProfileBindingsEnriched,
  bindOrgProfileProvider,
  unbindOrgProfileProvider,
} from "../../../src/services/state/org-profile-bindings.ts";

describe("org-profile-bindings", () => {
  let userId: string;
  let orgId: string;
  let defaultAppId: string;
  let orgProfileId: string;
  let userProfileId: string;

  beforeEach(async () => {
    await truncateAll();
    const { id } = await createTestUser({ name: "Test User" });
    userId = id;
    const { org, defaultAppId: appId } = await createTestOrg(userId);
    orgId = org.id;
    defaultAppId = appId;

    const orgProfile = await seedConnectionProfile({ orgId, name: "Org Profile" });
    orgProfileId = orgProfile.id;

    const userProfile = await seedConnectionProfile({ userId, name: "User Profile" });
    userProfileId = userProfile.id;
  });

  describe("getOrgProfileBindings", () => {
    it("returns empty map when no bindings exist", async () => {
      const bindings = await getOrgProfileBindings(orgProfileId, orgId);
      expect(bindings).toEqual({});
    });

    it("returns providerId to sourceProfileId map", async () => {
      await bindOrgProfileProvider(orgProfileId, "@test/gmail", userProfileId, userId);

      const bindings = await getOrgProfileBindings(orgProfileId, orgId);
      expect(bindings).toEqual({ "@test/gmail": userProfileId });
    });
  });

  describe("getOrgProfileBindingsEnriched", () => {
    it("returns connected true when source user has active connection", async () => {
      await bindOrgProfileProvider(orgProfileId, "@test/gmail", userProfileId, userId);
      await seedConnectionForApp(userProfileId, "@test/gmail", orgId, defaultAppId, {
        access_token: "tok",
      });

      const enriched = await getOrgProfileBindingsEnriched(orgProfileId, orgId);
      expect(enriched).toHaveLength(1);
      const e0 = enriched[0]!;
      expect(e0.providerId).toBe("@test/gmail");
      expect(e0.sourceProfileId).toBe(userProfileId);
      expect(e0.sourceProfileName).toBe("User Profile");
      expect(e0.boundByUserName).toBe("Test User");
      expect(e0.connected).toBe(true);
    });

    it("returns connected false when source user has no connection", async () => {
      await bindOrgProfileProvider(orgProfileId, "@test/gmail", userProfileId, userId);

      const enriched = await getOrgProfileBindingsEnriched(orgProfileId, orgId);
      expect(enriched).toHaveLength(1);
      expect(enriched[0]!.connected).toBe(false);
    });

    it("returns empty array when no bindings exist", async () => {
      const enriched = await getOrgProfileBindingsEnriched(orgProfileId, orgId);
      expect(enriched).toEqual([]);
    });
  });

  describe("bindOrgProfileProvider", () => {
    it("upserts on same provider and updates sourceProfileId", async () => {
      const profile2 = await seedConnectionProfile({ userId, name: "Profile 2" });

      await bindOrgProfileProvider(orgProfileId, "@test/gmail", userProfileId, userId);
      await bindOrgProfileProvider(orgProfileId, "@test/gmail", profile2.id, userId);

      const bindings = await getOrgProfileBindings(orgProfileId, orgId);
      expect(bindings["@test/gmail"]).toBe(profile2.id);
    });
  });

  describe("unbindOrgProfileProvider", () => {
    it("removes the binding", async () => {
      await bindOrgProfileProvider(orgProfileId, "@test/gmail", userProfileId, userId);
      await unbindOrgProfileProvider(orgProfileId, "@test/gmail");

      const bindings = await getOrgProfileBindings(orgProfileId, orgId);
      expect(bindings).toEqual({});
    });

    it("is idempotent when no binding exists", async () => {
      await unbindOrgProfileProvider(orgProfileId, "@test/nonexistent");
      // No throw
    });
  });
});
