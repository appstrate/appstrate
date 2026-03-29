/**
 * Tests for schedule readiness with org profiles.
 *
 * Isolated from scheduler.test.ts to avoid BullMQ fire-and-forget
 * race conditions with ensureDefaultProfile.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";

process.on("unhandledRejection", () => {});

import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedPackage, seedConnectionProfile } from "../../helpers/seed.ts";
import { flushRedis, closeRedis } from "../../helpers/redis.ts";
import { saveConnection } from "@appstrate/connect";
import { providerCredentials } from "@appstrate/db/schema";
import {
  createSchedule,
  listSchedules,
} from "../../../src/services/scheduler.ts";
import { bindOrgProfileProvider } from "../../../src/services/state/org-profile-bindings.ts";
import { ensureDefaultProfile } from "../../../src/services/connection-profiles.ts";

describe("scheduler org-profile readiness", () => {
  let userId: string;
  let orgId: string;
  let orgSlug: string;
  let userProfileId: string;

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    const { cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    orgSlug = org.slug;

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
      orgId: null as unknown as string,
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

    const flow = await seedPackage({
      orgId,
      id: `@${orgSlug}/flow-org-bound`,
      draftManifest: {
        name: `@${orgSlug}/flow-org-bound`,
        version: "0.1.0",
        type: "flow",
        description: "Flow with bound provider",
        dependencies: { providers: { [providerId]: "*" } },
      },
    });

    await createSchedule(flow.id, orgProfile.id, orgId, {
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

    const flow = await seedPackage({
      orgId,
      id: `@${orgSlug}/flow-org-unbound`,
      draftManifest: {
        name: `@${orgSlug}/flow-org-unbound`,
        version: "0.1.0",
        type: "flow",
        description: "Flow with unbound provider",
        dependencies: { providers: { [providerId]: "*" } },
      },
    });

    await createSchedule(flow.id, orgProfile.id, orgId, {
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
});
