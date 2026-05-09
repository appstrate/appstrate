// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedAgent, seedConnectionProfile } from "../../helpers/seed.ts";
import {
  getUserAgentProviderOverrides,
  setUserAgentProviderOverride,
  removeUserAgentProviderOverride,
} from "../../../src/services/connection-profiles.ts";
import type { Actor } from "../../../src/lib/actor.ts";

describe("agent provider overrides", () => {
  let actor: Actor;
  let orgId: string;
  let agentId: string;
  let profileId1: string;
  let profileId2: string;

  beforeEach(async () => {
    await truncateAll();
    const { id: userId } = await createTestUser();
    const { org } = await createTestOrg(userId);
    orgId = org.id;
    actor = { type: "user", id: userId };

    const agent = await seedAgent({ id: "@testorg/my-agent", orgId });
    agentId = agent.id;

    const p1 = await seedConnectionProfile({ userId, name: "Profile 1" });
    const p2 = await seedConnectionProfile({ userId, name: "Profile 2" });
    profileId1 = p1.id;
    profileId2 = p2.id;
  });

  describe("getUserAgentProviderOverrides", () => {
    it("returns empty map when no overrides exist", async () => {
      const overrides = await getUserAgentProviderOverrides(actor, agentId);
      expect(overrides).toEqual({});
    });

    it("returns all overrides for actor + package", async () => {
      await setUserAgentProviderOverride(actor, agentId, "@test/gmail", profileId1);
      await setUserAgentProviderOverride(actor, agentId, "@test/clickup", profileId2);

      const overrides = await getUserAgentProviderOverrides(actor, agentId);
      expect(overrides).toEqual({
        "@test/gmail": profileId1,
        "@test/clickup": profileId2,
      });
    });
  });

  describe("setUserAgentProviderOverride", () => {
    it("inserts a new override", async () => {
      await setUserAgentProviderOverride(actor, agentId, "@test/gmail", profileId1);

      const overrides = await getUserAgentProviderOverrides(actor, agentId);
      expect(overrides["@test/gmail"]).toBe(profileId1);
    });

    it("upserts when override already exists", async () => {
      await setUserAgentProviderOverride(actor, agentId, "@test/gmail", profileId1);
      await setUserAgentProviderOverride(actor, agentId, "@test/gmail", profileId2);

      const overrides = await getUserAgentProviderOverrides(actor, agentId);
      expect(overrides["@test/gmail"]).toBe(profileId2);
    });
  });

  describe("removeUserAgentProviderOverride", () => {
    it("removes a specific override", async () => {
      await setUserAgentProviderOverride(actor, agentId, "@test/gmail", profileId1);
      await setUserAgentProviderOverride(actor, agentId, "@test/clickup", profileId2);

      await removeUserAgentProviderOverride(actor, agentId, "@test/gmail");

      const overrides = await getUserAgentProviderOverrides(actor, agentId);
      expect(overrides["@test/gmail"]).toBeUndefined();
      expect(overrides["@test/clickup"]).toBe(profileId2);
    });

    it("is idempotent when override does not exist", async () => {
      await removeUserAgentProviderOverride(actor, agentId, "@test/nonexistent");

      const overrides = await getUserAgentProviderOverrides(actor, agentId);
      expect(overrides).toEqual({});
    });
  });

  describe("actor isolation", () => {
    it("does not return overrides from another user", async () => {
      const { id: otherUserId } = await createTestUser({ email: "other@test.com" });
      const otherActor: Actor = { type: "user", id: otherUserId };

      await setUserAgentProviderOverride(actor, agentId, "@test/gmail", profileId1);

      const overrides = await getUserAgentProviderOverrides(otherActor, agentId);
      expect(overrides).toEqual({});
    });
  });
});
