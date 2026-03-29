import { describe, it, expect, beforeEach } from "bun:test";
import { eq, and, sql } from "drizzle-orm";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg, addOrgMember } from "../../helpers/auth.ts";
import { seedConnectionProfile, seedFlow } from "../../helpers/seed.ts";
import { assertDbHas, assertDbMissing, assertDbCount, getDbRow } from "../../helpers/assertions.ts";
import {
  orgProfileProviderBindings,
  connectionProfiles,
  packageConfigs,
  userFlowProviderProfiles,
} from "@appstrate/db/schema";
import { bindOrgProfileProvider } from "../../../src/services/state/org-profile-bindings.ts";
import { setFlowOverride } from "../../../src/services/state/package-config.ts";
import {
  setUserFlowProviderOverride,
} from "../../../src/services/connection-profiles.ts";
import type { Actor } from "../../../src/lib/actor.ts";

describe("Cascade Deletion", () => {
  let userId: string;
  let orgId: string;
  let actor: Actor;

  beforeEach(async () => {
    await truncateAll();
    const { id } = await createTestUser();
    userId = id;
    const { org } = await createTestOrg(userId);
    orgId = org.id;
    actor = { type: "member", id: userId };
  });

  describe("when source profile (user profile) is deleted", () => {
    it("removes org profile bindings referencing it via FK CASCADE", async () => {
      const orgProfile = await seedConnectionProfile({ orgId, name: "Org Profile" });
      const userProfile = await seedConnectionProfile({ userId, name: "User Source" });

      await bindOrgProfileProvider(orgProfile.id, "@test/gmail", userProfile.id, userId);
      await bindOrgProfileProvider(orgProfile.id, "@test/clickup", userProfile.id, userId);

      // Verify bindings exist
      await assertDbCount(
        orgProfileProviderBindings,
        eq(orgProfileProviderBindings.sourceProfileId, userProfile.id),
        2,
      );

      // Delete the source (user) profile
      await db
        .delete(connectionProfiles)
        .where(eq(connectionProfiles.id, userProfile.id));

      // Bindings should be gone via FK CASCADE on sourceProfileId
      await assertDbMissing(
        orgProfileProviderBindings,
        eq(orgProfileProviderBindings.sourceProfileId, userProfile.id),
      );
    });

    it("removes user_flow_provider_profiles referencing it via FK CASCADE", async () => {
      const userProfile = await seedConnectionProfile({ userId, name: "Alt Profile" });

      const flow = await seedFlow({ id: "@testorg/cascade-flow", orgId, createdBy: userId });

      await setUserFlowProviderOverride(actor, flow.id, "@test/gmail", userProfile.id);

      // Verify override exists
      await assertDbHas(
        userFlowProviderProfiles,
        eq(userFlowProviderProfiles.profileId, userProfile.id),
      );

      // Delete the profile
      await db
        .delete(connectionProfiles)
        .where(eq(connectionProfiles.id, userProfile.id));

      // Override should be gone via FK CASCADE on profileId
      await assertDbMissing(
        userFlowProviderProfiles,
        eq(userFlowProviderProfiles.profileId, userProfile.id),
      );
    });
  });

  describe("when org profile is deleted", () => {
    it("nullifies package_configs.orgProfileId via FK SET NULL", async () => {
      const orgProfile = await seedConnectionProfile({ orgId, name: "Org Profile" });

      const flow = await seedFlow({ id: "@testorg/org-flow", orgId, createdBy: userId });

      // Set org profile on the flow config
      await setFlowOverride(orgId, flow.id, "orgProfileId", orgProfile.id);

      // Verify orgProfileId is set
      const configBefore = await getDbRow(
        packageConfigs,
        and(eq(packageConfigs.orgId, orgId), eq(packageConfigs.packageId, flow.id))!,
      );
      expect(configBefore.orgProfileId).toBe(orgProfile.id);

      // Delete the org profile
      await db
        .delete(connectionProfiles)
        .where(eq(connectionProfiles.id, orgProfile.id));

      // orgProfileId should be nullified (SET NULL)
      const configAfter = await getDbRow(
        packageConfigs,
        and(eq(packageConfigs.orgId, orgId), eq(packageConfigs.packageId, flow.id))!,
      );
      expect(configAfter.orgProfileId).toBeNull();
    });

    it("removes all org_profile_provider_bindings for the org profile", async () => {
      const orgProfile = await seedConnectionProfile({ orgId, name: "Org Profile" });
      const userProfile = await seedConnectionProfile({ userId, name: "Source" });

      await bindOrgProfileProvider(orgProfile.id, "@test/gmail", userProfile.id, userId);
      await bindOrgProfileProvider(orgProfile.id, "@test/clickup", userProfile.id, userId);

      // Verify bindings exist
      await assertDbCount(
        orgProfileProviderBindings,
        eq(orgProfileProviderBindings.orgProfileId, orgProfile.id),
        2,
      );

      // Delete the org profile
      await db
        .delete(connectionProfiles)
        .where(eq(connectionProfiles.id, orgProfile.id));

      // All bindings should be gone via FK CASCADE on orgProfileId
      await assertDbMissing(
        orgProfileProviderBindings,
        eq(orgProfileProviderBindings.orgProfileId, orgProfile.id),
      );
    });

    it("does not affect other org profiles or their bindings", async () => {
      const orgProfile1 = await seedConnectionProfile({ orgId, name: "Profile 1" });
      const orgProfile2 = await seedConnectionProfile({ orgId, name: "Profile 2" });
      const userProfile = await seedConnectionProfile({ userId, name: "Source" });

      await bindOrgProfileProvider(orgProfile1.id, "@test/gmail", userProfile.id, userId);
      await bindOrgProfileProvider(orgProfile2.id, "@test/gmail", userProfile.id, userId);

      // Delete profile 1
      await db
        .delete(connectionProfiles)
        .where(eq(connectionProfiles.id, orgProfile1.id));

      // Profile 2 and its binding should still exist
      await assertDbHas(
        connectionProfiles,
        eq(connectionProfiles.id, orgProfile2.id),
      );
      await assertDbHas(
        orgProfileProviderBindings,
        eq(orgProfileProviderBindings.orgProfileId, orgProfile2.id),
      );
    });

    it("nullifies orgProfileId on multiple flows that referenced the deleted profile", async () => {
      const orgProfile = await seedConnectionProfile({ orgId, name: "Shared Org Profile" });

      const flow1 = await seedFlow({ id: "@testorg/flow-a", orgId, createdBy: userId });
      const flow2 = await seedFlow({ id: "@testorg/flow-b", orgId, createdBy: userId });

      await setFlowOverride(orgId, flow1.id, "orgProfileId", orgProfile.id);
      await setFlowOverride(orgId, flow2.id, "orgProfileId", orgProfile.id);

      // Delete the org profile
      await db
        .delete(connectionProfiles)
        .where(eq(connectionProfiles.id, orgProfile.id));

      // Both flows should have orgProfileId nullified
      const config1 = await getDbRow(
        packageConfigs,
        and(eq(packageConfigs.orgId, orgId), eq(packageConfigs.packageId, flow1.id))!,
      );
      const config2 = await getDbRow(
        packageConfigs,
        and(eq(packageConfigs.orgId, orgId), eq(packageConfigs.packageId, flow2.id))!,
      );
      expect(config1.orgProfileId).toBeNull();
      expect(config2.orgProfileId).toBeNull();
    });
  });

  describe("when user is deleted (cascading through profiles)", () => {
    it("removes all user profiles and their downstream bindings", async () => {
      // Create a second user (member, not org owner) so we can delete them
      // without violating the organizations.created_by FK constraint.
      // session, account, and org_members all have onDelete: "cascade" on user_id,
      // so they are cleaned up automatically when the user row is deleted.
      const member = await createTestUser({ email: "member-to-delete@test.com" });
      await addOrgMember(orgId, member.id, "member");

      const memberProfile = await seedConnectionProfile({
        userId: member.id,
        name: "Member Prof",
      });
      const orgProfile = await seedConnectionProfile({ orgId, name: "Org Prof" });

      await bindOrgProfileProvider(orgProfile.id, "@test/gmail", memberProfile.id, member.id);

      // Verify setup
      await assertDbHas(
        connectionProfiles,
        eq(connectionProfiles.id, memberProfile.id),
      );
      await assertDbHas(
        orgProfileProviderBindings,
        eq(orgProfileProviderBindings.sourceProfileId, memberProfile.id),
      );

      // Delete the member user — cascades to session, account, org_members,
      // connection_profiles (via userId FK), and then to org_profile_provider_bindings
      // (via sourceProfileId FK on the deleted connection_profiles row)
      await db.execute(sql`DELETE FROM "user" WHERE id = ${member.id}`);

      // Member profile should be gone
      await assertDbMissing(
        connectionProfiles,
        eq(connectionProfiles.id, memberProfile.id),
      );

      // Binding should be gone (sourceProfileId cascade from deleted profile)
      await assertDbMissing(
        orgProfileProviderBindings,
        eq(orgProfileProviderBindings.sourceProfileId, memberProfile.id),
      );

      // Org profile should still exist (it belongs to org, not user)
      await assertDbHas(
        connectionProfiles,
        eq(connectionProfiles.id, orgProfile.id),
      );
    });
  });
});
