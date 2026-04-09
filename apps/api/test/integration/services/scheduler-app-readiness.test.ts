// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for schedule readiness with app profiles.
 *
 * Isolated from scheduler.test.ts to avoid BullMQ fire-and-forget
 * race conditions with ensureDefaultProfile.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";

// Scoped unhandledRejection handler — only swallows BullMQ-related rejections
let unhandledRejectionHandler: (reason: unknown) => void;

beforeAll(() => {
  unhandledRejectionHandler = (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (
      message.includes("bullmq") ||
      message.includes("Missing lock") ||
      message.includes("Connection is closed") ||
      message.includes("ensureDefaultProfile")
    ) {
      return; // Swallow BullMQ-related rejections
    }
    // Re-throw non-BullMQ rejections so they are not silently ignored
    throw reason;
  };
  process.on("unhandledRejection", unhandledRejectionHandler);
});

afterAll(() => {
  process.removeListener("unhandledRejection", unhandledRejectionHandler);
});

import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedPackage, seedConnectionProfile, seedConnectionForApp } from "../../helpers/seed.ts";
import { flushRedis, closeRedis } from "../../helpers/redis.ts";
import { applicationProviderCredentials } from "@appstrate/db/schema";
import { createSchedule, listSchedules } from "../../../src/modules/scheduling/service.ts";
import { bindAppProfileProvider } from "../../../src/services/state/app-profile-bindings.ts";
import {
  ensureDefaultProfile,
  resolveProviderProfiles,
  resolveScheduleProfileArgs,
  getProfileByIdUnsafe,
} from "../../../src/services/connection-profiles.ts";
import type { AgentProviderRequirement } from "../../../src/types/index.ts";

describe("scheduler app-profile readiness", () => {
  let userId: string;
  let orgId: string;
  let orgSlug: string;
  let defaultAppId: string;
  let userProfileId: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    const { cookie: _cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org, defaultAppId: appId } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    orgSlug = org.slug;
    defaultAppId = appId;

    // Use ensureDefaultProfile to avoid racing with the fire-and-forget
    // triggered by auth middleware during createTestUser sign-up
    const userProfile = await ensureDefaultProfile({ type: "member", id: userId });
    userProfileId = userProfile.id;
  });

  afterAll(async () => {
    await closeRedis();
  });

  async function seedProviderPackage(id: string) {
    await seedPackage({
      orgId: null,
      id,
      type: "provider",
      source: "system",
      draftManifest: {
        name: id,
        version: "1.0.0",
        type: "provider",
        description: `Provider ${id}`,
        definition: { authMode: "api_key" },
      },
    });
    await db.insert(applicationProviderCredentials).values({
      applicationId: defaultAppId,
      providerId: id,
      credentialsEncrypted: "{}",
      enabled: true,
    });
  }

  it("returns readiness 'ready' when app profile has provider bound and connected", async () => {
    const providerId = "@system/app-readiness-bound";
    await seedProviderPackage(providerId);
    await seedConnectionForApp(userProfileId, providerId, orgId, defaultAppId, { api_key: "k" });

    const appProfile = await seedConnectionProfile({
      applicationId: defaultAppId,
      name: "App Prod",
    });
    await bindAppProfileProvider(appProfile.id, providerId, userProfileId, userId);

    const agent = await seedPackage({
      orgId,
      id: `@${orgSlug}/agent-app-bound`,
      draftManifest: {
        name: `@${orgSlug}/agent-app-bound`,
        version: "0.1.0",
        type: "agent",
        description: "Agent with bound provider",
        dependencies: { providers: { [providerId]: "*" } },
      },
    });

    await createSchedule(agent.id, appProfile.id, orgId, defaultAppId, {
      name: "App Bound Schedule",
      cronExpression: "0 * * * *",
    });

    const schedules = await listSchedules(orgId, defaultAppId);
    const s = schedules.find((s) => s.name === "App Bound Schedule")!;

    expect(s.profileType).toBe("app");
    expect(s.readiness.status).toBe("ready");
    expect(s.readiness.totalProviders).toBe(1);
    expect(s.readiness.connectedProviders).toBe(1);
  });

  it("returns readiness 'not_ready' when app profile has provider NOT bound", async () => {
    const providerId = "@system/app-readiness-unbound";
    await seedProviderPackage(providerId);

    const appProfile = await seedConnectionProfile({
      applicationId: defaultAppId,
      name: "App Empty",
    });

    const agent = await seedPackage({
      orgId,
      id: `@${orgSlug}/agent-app-unbound`,
      draftManifest: {
        name: `@${orgSlug}/agent-app-unbound`,
        version: "0.1.0",
        type: "agent",
        description: "Agent with unbound provider",
        dependencies: { providers: { [providerId]: "*" } },
      },
    });

    await createSchedule(agent.id, appProfile.id, orgId, defaultAppId, {
      name: "App Unbound Schedule",
      cronExpression: "0 * * * *",
    });

    const schedules = await listSchedules(orgId, defaultAppId);
    const s = schedules.find((s) => s.name === "App Unbound Schedule")!;

    expect(s.profileType).toBe("app");
    expect(s.readiness.status).toBe("not_ready");
    expect(s.readiness.totalProviders).toBe(1);
    expect(s.readiness.connectedProviders).toBe(0);
    expect(s.readiness.missingProviders).toEqual([providerId]);
  });

  // ── Run-path resolution (triggerScheduledRun parity) ──

  it("resolves providers via app bindings without agentAppProfileId (run path)", async () => {
    // This is the exact scenario that caused the production bug:
    // schedule uses app profile, no agentAppProfileId in application_packages,
    // providers connected only via app profile bindings.
    const providerId = "@system/app-exec-path";
    await seedProviderPackage(providerId);
    await seedConnectionForApp(userProfileId, providerId, orgId, defaultAppId, { api_key: "k" });

    const appProfile = await seedConnectionProfile({
      applicationId: defaultAppId,
      name: "App Exec",
    });
    await bindAppProfileProvider(appProfile.id, providerId, userProfileId, userId);

    // Simulate what triggerScheduledRun does:
    // 1. Load profile
    const profile = await getProfileByIdUnsafe(appProfile.id);
    expect(profile).not.toBeNull();

    // 2. Resolve args with NO agentAppProfileId (not configured in application_packages)
    const { defaultUserProfileId, appProfileId } = resolveScheduleProfileArgs(
      profile!,
      appProfile.id,
      null, // no agentAppProfileId — the production bug scenario
    );

    // 3. Resolve provider profiles
    const providers: AgentProviderRequirement[] = [{ id: providerId }];
    const providerProfiles = await resolveProviderProfiles(
      providers,
      defaultUserProfileId,
      undefined,
      appProfileId,
      defaultAppId,
    );

    // Provider should be resolved via app binding
    expect(providerProfiles[providerId]).toBeDefined();
    expect(providerProfiles[providerId]!.source).toBe("app_binding");
    expect(providerProfiles[providerId]!.profileId).toBe(userProfileId);
  });

  it("omits provider when app profile has no binding and no user fallback (run path)", async () => {
    const providerId = "@system/app-exec-missing";
    await seedProviderPackage(providerId);

    // App profile with NO bindings
    const appProfile = await seedConnectionProfile({
      applicationId: defaultAppId,
      name: "App No Bindings",
    });

    const profile = await getProfileByIdUnsafe(appProfile.id);
    const { defaultUserProfileId, appProfileId } = resolveScheduleProfileArgs(
      profile!,
      appProfile.id,
      null,
    );

    const providers: AgentProviderRequirement[] = [{ id: providerId }];
    const providerProfiles = await resolveProviderProfiles(
      providers,
      defaultUserProfileId,
      undefined,
      appProfileId,
      defaultAppId,
    );

    // Provider not in map — no binding, no user fallback
    expect(providerProfiles[providerId]).toBeUndefined();
  });
});
