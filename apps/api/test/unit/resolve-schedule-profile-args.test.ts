// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { resolveScheduleProfileArgs } from "../../src/services/connection-profiles.ts";
import type { ConnectionProfile } from "@appstrate/db/schema";

function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: "profile-1",
    userId: null,
    endUserId: null,
    applicationId: null,
    name: "Test",
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("resolveScheduleProfileArgs", () => {
  it("passes app profile as appProfileId with null user fallback", () => {
    const profile = makeProfile({ applicationId: "app-1" });
    const result = resolveScheduleProfileArgs(profile, "app-profile-id");

    expect(result).toEqual({
      defaultUserProfileId: null,
      appProfileId: "app-profile-id",
    });
  });

  it("passes user profile as defaultUserProfileId with null appProfileId", () => {
    const profile = makeProfile({ userId: "user-1" });
    const result = resolveScheduleProfileArgs(profile, "user-profile-id");

    expect(result).toEqual({
      defaultUserProfileId: "user-profile-id",
      appProfileId: null,
    });
  });

  it("passes user profile with agentAppProfileId as app fallback", () => {
    const profile = makeProfile({ userId: "user-1" });
    const result = resolveScheduleProfileArgs(profile, "user-profile-id", "agent-app-profile-id");

    expect(result).toEqual({
      defaultUserProfileId: "user-profile-id",
      appProfileId: "agent-app-profile-id",
    });
  });

  it("app profile ignores agentAppProfileId — schedule's own app profile takes priority", () => {
    const profile = makeProfile({ applicationId: "app-1" });
    const result = resolveScheduleProfileArgs(
      profile,
      "schedule-app-profile",
      "agent-app-profile-id",
    );

    expect(result).toEqual({
      defaultUserProfileId: null,
      appProfileId: "schedule-app-profile",
    });
  });

  it("handles end-user profile as user profile (no applicationId)", () => {
    const profile = makeProfile({ endUserId: "eu-1" });
    const result = resolveScheduleProfileArgs(profile, "eu-profile-id");

    expect(result).toEqual({
      defaultUserProfileId: "eu-profile-id",
      appProfileId: null,
    });
  });

  it("handles null agentAppProfileId for user profile", () => {
    const profile = makeProfile({ userId: "user-1" });
    const result = resolveScheduleProfileArgs(profile, "user-profile-id", null);

    expect(result).toEqual({
      defaultUserProfileId: "user-profile-id",
      appProfileId: null,
    });
  });
});
