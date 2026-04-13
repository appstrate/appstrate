// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { eq, and, sql } from "drizzle-orm";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg, addOrgMember } from "../../helpers/auth.ts";
import {
  seedConnectionProfile,
  seedAgent,
  seedApplication,
  seedEndUser,
  seedSchedule,
  seedApiKey,
  seedRun,
} from "../../helpers/seed.ts";
import { assertDbHas, assertDbMissing, assertDbCount, getDbRow } from "../../helpers/assertions.ts";
import {
  appProfileProviderBindings,
  connectionProfiles,
  applicationPackages,
  userAgentProviderProfiles,
  applications,
  endUsers,
  apiKeys,
  runs,
  schedules,
} from "@appstrate/db/schema";
import { bindAppProfileProvider } from "../../../src/services/state/app-profile-bindings.ts";
import {
  updateInstalledPackage,
  installPackage,
} from "../../../src/services/application-packages.ts";
import { setUserAgentProviderOverride } from "../../../src/services/connection-profiles.ts";
import { deleteApplication } from "../../../src/services/applications.ts";
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
    it("removes app profile bindings referencing it via FK CASCADE", async () => {
      const appProfile = await seedConnectionProfile({ applicationId: appId, name: "Org Profile" });
      const userProfile = await seedConnectionProfile({ userId, name: "User Source" });

      await bindAppProfileProvider(appProfile.id, "@test/gmail", userProfile.id, userId);
      await bindAppProfileProvider(appProfile.id, "@test/clickup", userProfile.id, userId);

      // Verify bindings exist
      await assertDbCount(
        appProfileProviderBindings,
        eq(appProfileProviderBindings.sourceProfileId, userProfile.id),
        2,
      );

      // Delete the source (user) profile
      await db.delete(connectionProfiles).where(eq(connectionProfiles.id, userProfile.id));

      // Bindings should be gone via FK CASCADE on sourceProfileId
      await assertDbMissing(
        appProfileProviderBindings,
        eq(appProfileProviderBindings.sourceProfileId, userProfile.id),
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

  describe("when app profile is deleted", () => {
    it("nullifies application_packages.appProfileId via FK SET NULL", async () => {
      const appProfile = await seedConnectionProfile({ applicationId: appId, name: "Org Profile" });

      const agent = await seedAgent({ id: "@testorg/org-agent", orgId, createdBy: userId });
      await installPackage(appId, orgId, agent.id);

      // Set app profile on the agent config
      await updateInstalledPackage(appId, agent.id, { appProfileId: appProfile.id });

      // Verify appProfileId is set
      const configBefore = await getDbRow(
        applicationPackages,
        and(
          eq(applicationPackages.applicationId, appId),
          eq(applicationPackages.packageId, agent.id),
        )!,
      );
      expect(configBefore.appProfileId).toBe(appProfile.id);

      // Delete the app profile
      await db.delete(connectionProfiles).where(eq(connectionProfiles.id, appProfile.id));

      // appProfileId should be nullified (SET NULL)
      const configAfter = await getDbRow(
        applicationPackages,
        and(
          eq(applicationPackages.applicationId, appId),
          eq(applicationPackages.packageId, agent.id),
        )!,
      );
      expect(configAfter.appProfileId).toBeNull();
    });

    it("removes all app_profile_provider_bindings for the app profile", async () => {
      const appProfile = await seedConnectionProfile({ applicationId: appId, name: "Org Profile" });
      const userProfile = await seedConnectionProfile({ userId, name: "Source" });

      await bindAppProfileProvider(appProfile.id, "@test/gmail", userProfile.id, userId);
      await bindAppProfileProvider(appProfile.id, "@test/clickup", userProfile.id, userId);

      // Verify bindings exist
      await assertDbCount(
        appProfileProviderBindings,
        eq(appProfileProviderBindings.appProfileId, appProfile.id),
        2,
      );

      // Delete the app profile
      await db.delete(connectionProfiles).where(eq(connectionProfiles.id, appProfile.id));

      // All bindings should be gone via FK CASCADE on appProfileId
      await assertDbMissing(
        appProfileProviderBindings,
        eq(appProfileProviderBindings.appProfileId, appProfile.id),
      );
    });

    it("does not affect other app profiles or their bindings", async () => {
      const appProfile1 = await seedConnectionProfile({ applicationId: appId, name: "Profile 1" });
      const appProfile2 = await seedConnectionProfile({ applicationId: appId, name: "Profile 2" });
      const userProfile = await seedConnectionProfile({ userId, name: "Source" });

      await bindAppProfileProvider(appProfile1.id, "@test/gmail", userProfile.id, userId);
      await bindAppProfileProvider(appProfile2.id, "@test/gmail", userProfile.id, userId);

      // Delete profile 1
      await db.delete(connectionProfiles).where(eq(connectionProfiles.id, appProfile1.id));

      // Profile 2 and its binding should still exist
      await assertDbHas(connectionProfiles, eq(connectionProfiles.id, appProfile2.id));
      await assertDbHas(
        appProfileProviderBindings,
        eq(appProfileProviderBindings.appProfileId, appProfile2.id),
      );
    });

    it("nullifies appProfileId on multiple agents that referenced the deleted profile", async () => {
      const appProfile = await seedConnectionProfile({
        applicationId: appId,
        name: "Shared Org Profile",
      });

      const agent1 = await seedAgent({ id: "@testorg/agent-a", orgId, createdBy: userId });
      const agent2 = await seedAgent({ id: "@testorg/agent-b", orgId, createdBy: userId });
      await installPackage(appId, orgId, agent1.id);
      await installPackage(appId, orgId, agent2.id);

      await updateInstalledPackage(appId, agent1.id, { appProfileId: appProfile.id });
      await updateInstalledPackage(appId, agent2.id, { appProfileId: appProfile.id });

      // Delete the app profile
      await db.delete(connectionProfiles).where(eq(connectionProfiles.id, appProfile.id));

      // Both agents should have appProfileId nullified
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
      expect(config1.appProfileId).toBeNull();
      expect(config2.appProfileId).toBeNull();
    });
  });

  describe("when application is deleted", () => {
    it("cascades to end-users, schedules, api-keys, runs, and installed packages", async () => {
      // Create a custom (non-default) application
      const customApp = await seedApplication({ orgId, name: "Cascade Target", createdBy: userId });

      const agent = await seedAgent({ id: "@testorg/casc-agent", orgId, createdBy: userId });

      // Create a connection profile for the schedule
      const profile = await seedConnectionProfile({ userId, name: "Sched Profile" });

      // Populate the app with resources
      await installPackage(customApp.id, orgId, agent.id);
      const eu = await seedEndUser({ orgId, applicationId: customApp.id, name: "Test EU" });
      const key = await seedApiKey({ orgId, applicationId: customApp.id, createdBy: userId });
      const run = await seedRun({ orgId, applicationId: customApp.id, packageId: agent.id });
      const sched = await seedSchedule({
        orgId,
        applicationId: customApp.id,
        packageId: agent.id,
        connectionProfileId: profile.id,
      });

      // Verify all resources exist
      await assertDbHas(applicationPackages, eq(applicationPackages.applicationId, customApp.id));
      await assertDbHas(endUsers, eq(endUsers.id, eu.id));
      await assertDbHas(apiKeys, eq(apiKeys.id, key.id));
      await assertDbHas(runs, eq(runs.id, run.id));
      await assertDbHas(schedules, eq(schedules.id, sched.id));

      // Delete the application
      await deleteApplication(orgId, customApp.id);

      // All related resources should be gone via FK CASCADE
      await assertDbMissing(applications, eq(applications.id, customApp.id));
      await assertDbMissing(
        applicationPackages,
        eq(applicationPackages.applicationId, customApp.id),
      );
      await assertDbMissing(endUsers, eq(endUsers.id, eu.id));
      await assertDbMissing(apiKeys, eq(apiKeys.id, key.id));
      await assertDbMissing(runs, eq(runs.id, run.id));
      await assertDbMissing(schedules, eq(schedules.id, sched.id));
    });

    it("does not affect the default application or its resources", async () => {
      const defaultKey = await seedApiKey({
        orgId,
        applicationId: appId,
        createdBy: userId,
      });

      // Create and delete a custom app
      const customApp = await seedApplication({ orgId, name: "Expendable", createdBy: userId });
      await seedApiKey({ orgId, applicationId: customApp.id, createdBy: userId });
      await deleteApplication(orgId, customApp.id);

      // Default app and its api key should still exist
      await assertDbHas(applications, eq(applications.id, appId));
      await assertDbHas(apiKeys, eq(apiKeys.id, defaultKey.id));
    });

    it("rejects deletion of the default application", async () => {
      await expect(deleteApplication(orgId, appId)).rejects.toThrow();
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
      const appProfile = await seedConnectionProfile({ applicationId: appId, name: "Org Prof" });

      await bindAppProfileProvider(appProfile.id, "@test/gmail", memberProfile.id, member.id);

      // Verify setup
      await assertDbHas(connectionProfiles, eq(connectionProfiles.id, memberProfile.id));
      await assertDbHas(
        appProfileProviderBindings,
        eq(appProfileProviderBindings.sourceProfileId, memberProfile.id),
      );

      // Delete the member user — cascades to session, account, org_members,
      // connection_profiles (via userId FK), and then to app_profile_provider_bindings
      // (via sourceProfileId FK on the deleted connection_profiles row)
      await db.execute(sql`DELETE FROM "user" WHERE id = ${member.id}`);

      // Member profile should be gone
      await assertDbMissing(connectionProfiles, eq(connectionProfiles.id, memberProfile.id));

      // Binding should be gone (sourceProfileId cascade from deleted profile)
      await assertDbMissing(
        appProfileProviderBindings,
        eq(appProfileProviderBindings.sourceProfileId, memberProfile.id),
      );

      // Org profile should still exist (it belongs to org, not user)
      await assertDbHas(connectionProfiles, eq(connectionProfiles.id, appProfile.id));
    });
  });
});
