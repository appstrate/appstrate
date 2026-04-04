// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for schedule readiness with org profiles.
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
import { seedPackage, seedConnectionProfile } from "../../helpers/seed.ts";
import { flushRedis, closeRedis } from "../../helpers/redis.ts";
import { saveConnection } from "@appstrate/connect";
import { providerCredentials } from "@appstrate/db/schema";
import { createSchedule, listSchedules } from "../../../src/services/scheduler.ts";
import { bindOrgProfileProvider } from "../../../src/services/state/org-profile-bindings.ts";
import {
  ensureDefaultProfile,
  resolveProviderProfiles,
  resolveScheduleProfileArgs,
  getProfileByIdUnsafe,
} from "../../../src/services/connection-profiles.ts";
import type { AgentProviderRequirement } from "../../../src/types/index.ts";

describe("scheduler org-profile readiness", () => {
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
    await db.insert(providerCredentials).values({
      providerId: id,
      orgId,
      credentialsEncrypted: "{}",
      enabled: true,
    });
  }

  it("returns readiness 'ready' when org profile has provider bound and connected", async () => {
    const providerId = "@system/org-readiness-bound";
    await seedProviderPackage(providerId);
    await saveConnection(db, userProfileId, providerId, orgId, { api_key: "k" });

    const orgProfile = await seedConnectionProfile({ orgId, name: "Org Prod" });
    await bindOrgProfileProvider(orgProfile.id, providerId, userProfileId, userId);

    const agent = await seedPackage({
      orgId,
      id: `@${orgSlug}/agent-org-bound`,
      draftManifest: {
        name: `@${orgSlug}/agent-org-bound`,
        version: "0.1.0",
        type: "agent",
        description: "Agent with bound provider",
        dependencies: { providers: { [providerId]: "*" } },
      },
    });

    await createSchedule(agent.id, orgProfile.id, orgId, defaultAppId, {
      name: "Org Bound Schedule",
      cronExpression: "0 * * * *",
    });

    const schedules = await listSchedules(orgId);
    const s = schedules.find((s) => s.name === "Org Bound Schedule")!;

    expect(s.profileType).toBe("org");
    expect(s.readiness.status).toBe("ready");
    expect(s.readiness.totalProviders).toBe(1);
    expect(s.readiness.connectedProviders).toBe(1);
  });

  it("returns readiness 'not_ready' when org profile has provider NOT bound", async () => {
    const providerId = "@system/org-readiness-unbound";
    await seedProviderPackage(providerId);

    const orgProfile = await seedConnectionProfile({ orgId, name: "Org Empty" });

    const agent = await seedPackage({
      orgId,
      id: `@${orgSlug}/agent-org-unbound`,
      draftManifest: {
        name: `@${orgSlug}/agent-org-unbound`,
        version: "0.1.0",
        type: "agent",
        description: "Agent with unbound provider",
        dependencies: { providers: { [providerId]: "*" } },
      },
    });

    await createSchedule(agent.id, orgProfile.id, orgId, defaultAppId, {
      name: "Org Unbound Schedule",
      cronExpression: "0 * * * *",
    });

    const schedules = await listSchedules(orgId);
    const s = schedules.find((s) => s.name === "Org Unbound Schedule")!;

    expect(s.profileType).toBe("org");
    expect(s.readiness.status).toBe("not_ready");
    expect(s.readiness.totalProviders).toBe(1);
    expect(s.readiness.connectedProviders).toBe(0);
    expect(s.readiness.missingProviders).toEqual([providerId]);
  });

  // ── Run-path resolution (triggerScheduledRun parity) ──

  it("resolves providers via org bindings without agentOrgProfileId (run path)", async () => {
    // This is the exact scenario that caused the production bug:
    // schedule uses org profile, no agentOrgProfileId in package_configs,
    // providers connected only via org profile bindings.
    const providerId = "@system/org-exec-path";
    await seedProviderPackage(providerId);
    await saveConnection(db, userProfileId, providerId, orgId, { api_key: "k" });

    const orgProfile = await seedConnectionProfile({ orgId, name: "Org Exec" });
    await bindOrgProfileProvider(orgProfile.id, providerId, userProfileId, userId);

    // Simulate what triggerScheduledRun does:
    // 1. Load profile
    const profile = await getProfileByIdUnsafe(orgProfile.id);
    expect(profile).not.toBeNull();

    // 2. Resolve args with NO agentOrgProfileId (not configured in package_configs)
    const { defaultUserProfileId, orgProfileId } = resolveScheduleProfileArgs(
      profile!,
      orgProfile.id,
      null, // no agentOrgProfileId — the production bug scenario
    );

    // 3. Resolve provider profiles
    const providers: AgentProviderRequirement[] = [{ id: providerId }];
    const providerProfiles = await resolveProviderProfiles(
      providers,
      defaultUserProfileId,
      undefined,
      orgProfileId,
      orgId,
    );

    // Provider should be resolved via org binding
    expect(providerProfiles[providerId]).toBeDefined();
    expect(providerProfiles[providerId]!.source).toBe("org_binding");
    expect(providerProfiles[providerId]!.profileId).toBe(userProfileId);
  });

  it("omits provider when org profile has no binding and no user fallback (run path)", async () => {
    const providerId = "@system/org-exec-missing";
    await seedProviderPackage(providerId);

    // Org profile with NO bindings
    const orgProfile = await seedConnectionProfile({ orgId, name: "Org No Bindings" });

    const profile = await getProfileByIdUnsafe(orgProfile.id);
    const { defaultUserProfileId, orgProfileId } = resolveScheduleProfileArgs(
      profile!,
      orgProfile.id,
      null,
    );

    const providers: AgentProviderRequirement[] = [{ id: providerId }];
    const providerProfiles = await resolveProviderProfiles(
      providers,
      defaultUserProfileId,
      undefined,
      orgProfileId,
      orgId,
    );

    // Provider not in map — no binding, no user fallback
    expect(providerProfiles[providerId]).toBeUndefined();
  });
});
