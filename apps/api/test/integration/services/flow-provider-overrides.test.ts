// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedFlow, seedConnectionProfile } from "../../helpers/seed.ts";
import {
  getUserFlowProviderOverrides,
  setUserFlowProviderOverride,
  removeUserFlowProviderOverride,
} from "../../../src/services/connection-profiles.ts";
import type { Actor } from "../../../src/lib/actor.ts";

describe("flow provider overrides", () => {
  let actor: Actor;
  let orgId: string;
  let flowId: string;
  let profileId1: string;
  let profileId2: string;

  beforeEach(async () => {
    await truncateAll();
    const { id: userId } = await createTestUser();
    const { org } = await createTestOrg(userId);
    orgId = org.id;
    actor = { type: "member", id: userId };

    const flow = await seedFlow({ id: "@testorg/my-flow", orgId });
    flowId = flow.id;

    const p1 = await seedConnectionProfile({ userId, name: "Profile 1" });
    const p2 = await seedConnectionProfile({ userId, name: "Profile 2" });
    profileId1 = p1.id;
    profileId2 = p2.id;
  });

  describe("getUserFlowProviderOverrides", () => {
    it("returns empty map when no overrides exist", async () => {
      const overrides = await getUserFlowProviderOverrides(actor, flowId);
      expect(overrides).toEqual({});
    });

    it("returns all overrides for actor + package", async () => {
      await setUserFlowProviderOverride(actor, flowId, "@test/gmail", profileId1);
      await setUserFlowProviderOverride(actor, flowId, "@test/clickup", profileId2);

      const overrides = await getUserFlowProviderOverrides(actor, flowId);
      expect(overrides).toEqual({
        "@test/gmail": profileId1,
        "@test/clickup": profileId2,
      });
    });
  });

  describe("setUserFlowProviderOverride", () => {
    it("inserts a new override", async () => {
      await setUserFlowProviderOverride(actor, flowId, "@test/gmail", profileId1);

      const overrides = await getUserFlowProviderOverrides(actor, flowId);
      expect(overrides["@test/gmail"]).toBe(profileId1);
    });

    it("upserts when override already exists", async () => {
      await setUserFlowProviderOverride(actor, flowId, "@test/gmail", profileId1);
      await setUserFlowProviderOverride(actor, flowId, "@test/gmail", profileId2);

      const overrides = await getUserFlowProviderOverrides(actor, flowId);
      expect(overrides["@test/gmail"]).toBe(profileId2);
    });
  });

  describe("removeUserFlowProviderOverride", () => {
    it("removes a specific override", async () => {
      await setUserFlowProviderOverride(actor, flowId, "@test/gmail", profileId1);
      await setUserFlowProviderOverride(actor, flowId, "@test/clickup", profileId2);

      await removeUserFlowProviderOverride(actor, flowId, "@test/gmail");

      const overrides = await getUserFlowProviderOverrides(actor, flowId);
      expect(overrides["@test/gmail"]).toBeUndefined();
      expect(overrides["@test/clickup"]).toBe(profileId2);
    });

    it("is idempotent when override does not exist", async () => {
      await removeUserFlowProviderOverride(actor, flowId, "@test/nonexistent");

      const overrides = await getUserFlowProviderOverrides(actor, flowId);
      expect(overrides).toEqual({});
    });
  });

  describe("actor isolation", () => {
    it("does not return overrides from another user", async () => {
      const { id: otherUserId } = await createTestUser({ email: "other@test.com" });
      const otherActor: Actor = { type: "member", id: otherUserId };

      await setUserFlowProviderOverride(actor, flowId, "@test/gmail", profileId1);

      const overrides = await getUserFlowProviderOverrides(otherActor, flowId);
      expect(overrides).toEqual({});
    });
  });
});
