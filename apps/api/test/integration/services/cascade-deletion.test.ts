// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, and, sql } from "drizzle-orm";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg, addOrgMember } from "../../helpers/auth.ts";
import { seedConnectionProfile, seedAgent } from "../../helpers/seed.ts";
import { assertDbHas, assertDbMissing, assertDbCount, getDbRow } from "../../helpers/assertions.ts";
import {
  orgProfileProviderBindings,
  connectionProfiles,
  applicationPackages,
  userAgentProviderProfiles,
} from "@appstrate/db/schema";
import { bindOrgProfileProvider } from "../../../src/services/state/org-profile-bindings.ts";
import {
  updateInstalledPackage,
  installPackage,
} from "../../../src/services/application-packages.ts";
import { setUserAgentProviderOverride } from "../../../src/services/connection-profiles.ts";
import type { Actor } from "../../../src/lib/actor.ts";

describe("Cascade Deletion", () => {
  let userId: string;
  let orgId: string;
  let appId: string;
  let actor: Actor;

  beforeEach(async () => {
    await truncateAll();
    const { id } = await createTestUser();
    userId = id;
    const { org, defaultAppId } = await createTestOrg(userId);
    orgId = org.id;
    appId = defaultAppId;
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
      await db.delete(connectionProfiles).where(eq(connectionProfiles.id, userProfile.id));

      // Bindings should be gone via FK CASCADE on sourceProfileId
      await assertDbMissing(
        orgProfileProviderBindings,
        eq(orgProfileProviderBindings.sourceProfileId, userProfile.id),
      );
    });

    it("removes user_agent_provider_profiles referencing it via FK CASCADE", async () => {
      const userProfile = await seedConnectionProfile({ userId, name: "Alt Profile" });

      const agent = await seedAgent({ id: "@testorg/cascade-agent", orgId, createdBy: userId });

      await setUserAgentProviderOverride(actor, agent.id, "@test/gmail", userProfile.id);

      // Verify override exists
      await assertDbHas(
        userAgentProviderProfiles,
        eq(userAgentProviderProfiles.profileId, userProfile.id),
      );

      // Delete the profile
      await db.delete(connectionProfiles).where(eq(connectionProfiles.id, userProfile.id));

      // Override should be gone via FK CASCADE on profileId
      await assertDbMissing(
        userAgentProviderProfiles,
        eq(userAgentProviderProfiles.profileId, userProfile.id),
      );
    });
  });

  describe("when org profile is deleted", () => {
    it("nullifies application_packages.orgProfileId via FK SET NULL", async () => {
      const orgProfile = await seedConnectionProfile({ orgId, name: "Org Profile" });

      const agent = await seedAgent({ id: "@testorg/org-agent", orgId, createdBy: userId });
      await installPackage(appId, orgId, agent.id);

      // Set org profile on the agent config
      await updateInstalledPackage(appId, agent.id, { orgProfileId: orgProfile.id });

      // Verify orgProfileId is set
      const configBefore = await getDbRow(
        applicationPackages,
        and(
          eq(applicationPackages.applicationId, appId),
          eq(applicationPackages.packageId, agent.id),
        )!,
      );
      expect(configBefore.orgProfileId).toBe(orgProfile.id);

      // Delete the org profile
      await db.delete(connectionProfiles).where(eq(connectionProfiles.id, orgProfile.id));

      // orgProfileId should be nullified (SET NULL)
      const configAfter = await getDbRow(
        applicationPackages,
        and(
          eq(applicationPackages.applicationId, appId),
          eq(applicationPackages.packageId, agent.id),
        )!,
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
      await db.delete(connectionProfiles).where(eq(connectionProfiles.id, orgProfile.id));

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
      await db.delete(connectionProfiles).where(eq(connectionProfiles.id, orgProfile1.id));

      // Profile 2 and its binding should still exist
      await assertDbHas(connectionProfiles, eq(connectionProfiles.id, orgProfile2.id));
      await assertDbHas(
        orgProfileProviderBindings,
        eq(orgProfileProviderBindings.orgProfileId, orgProfile2.id),
      );
    });

    it("nullifies orgProfileId on multiple agents that referenced the deleted profile", async () => {
      const orgProfile = await seedConnectionProfile({ orgId, name: "Shared Org Profile" });

      const agent1 = await seedAgent({ id: "@testorg/agent-a", orgId, createdBy: userId });
      const agent2 = await seedAgent({ id: "@testorg/agent-b", orgId, createdBy: userId });
      await installPackage(appId, orgId, agent1.id);
      await installPackage(appId, orgId, agent2.id);

      await updateInstalledPackage(appId, agent1.id, { orgProfileId: orgProfile.id });
      await updateInstalledPackage(appId, agent2.id, { orgProfileId: orgProfile.id });

      // Delete the org profile
      await db.delete(connectionProfiles).where(eq(connectionProfiles.id, orgProfile.id));

      // Both agents should have orgProfileId nullified
      const config1 = await getDbRow(
        applicationPackages,
        and(
          eq(applicationPackages.applicationId, appId),
          eq(applicationPackages.packageId, agent1.id),
        )!,
      );
      const config2 = await getDbRow(
        applicationPackages,
        and(
          eq(applicationPackages.applicationId, appId),
          eq(applicationPackages.packageId, agent2.id),
        )!,
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
      await assertDbHas(connectionProfiles, eq(connectionProfiles.id, memberProfile.id));
      await assertDbHas(
        orgProfileProviderBindings,
        eq(orgProfileProviderBindings.sourceProfileId, memberProfile.id),
      );

      // Delete the member user — cascades to session, account, org_members,
      // connection_profiles (via userId FK), and then to org_profile_provider_bindings
      // (via sourceProfileId FK on the deleted connection_profiles row)
      await db.execute(sql`DELETE FROM "user" WHERE id = ${member.id}`);

      // Member profile should be gone
      await assertDbMissing(connectionProfiles, eq(connectionProfiles.id, memberProfile.id));

      // Binding should be gone (sourceProfileId cascade from deleted profile)
      await assertDbMissing(
        orgProfileProviderBindings,
        eq(orgProfileProviderBindings.sourceProfileId, memberProfile.id),
      );

      // Org profile should still exist (it belongs to org, not user)
      await assertDbHas(connectionProfiles, eq(connectionProfiles.id, orgProfile.id));
    });
  });
});
