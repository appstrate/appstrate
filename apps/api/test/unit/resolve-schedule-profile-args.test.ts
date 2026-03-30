import { describe, it, expect } from "bun:test";
import { resolveScheduleProfileArgs } from "../../src/services/connection-profiles.ts";
import type { ConnectionProfile } from "@appstrate/db/schema";

function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: "profile-1",
    userId: null,
    endUserId: null,
    orgId: null,
    name: "Test",
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("resolveScheduleProfileArgs", () => {
  it("passes org profile as orgProfileId with null user fallback", () => {
    const profile = makeProfile({ orgId: "org-1" });
    const result = resolveScheduleProfileArgs(profile, "org-profile-id");

    expect(result).toEqual({
      defaultUserProfileId: null,
      orgProfileId: "org-profile-id",
    });
  });

  it("passes user profile as defaultUserProfileId with null orgProfileId", () => {
    const profile = makeProfile({ userId: "user-1" });
    const result = resolveScheduleProfileArgs(profile, "user-profile-id");

    expect(result).toEqual({
      defaultUserProfileId: "user-profile-id",
      orgProfileId: null,
    });
  });

  it("passes user profile with flowOrgProfileId as org fallback", () => {
    const profile = makeProfile({ userId: "user-1" });
    const result = resolveScheduleProfileArgs(profile, "user-profile-id", "flow-org-profile-id");

    expect(result).toEqual({
      defaultUserProfileId: "user-profile-id",
      orgProfileId: "flow-org-profile-id",
    });
  });

  it("org profile ignores flowOrgProfileId — schedule's own org profile takes priority", () => {
    const profile = makeProfile({ orgId: "org-1" });
    const result = resolveScheduleProfileArgs(
      profile,
      "schedule-org-profile",
      "flow-org-profile-id",
    );

    expect(result).toEqual({
      defaultUserProfileId: null,
      orgProfileId: "schedule-org-profile",
    });
  });

  it("handles end-user profile as user profile (no orgId)", () => {
    const profile = makeProfile({ endUserId: "eu-1" });
    const result = resolveScheduleProfileArgs(profile, "eu-profile-id");

    expect(result).toEqual({
      defaultUserProfileId: "eu-profile-id",
      orgProfileId: null,
    });
  });

  it("handles null flowOrgProfileId for user profile", () => {
    const profile = makeProfile({ userId: "user-1" });
    const result = resolveScheduleProfileArgs(profile, "user-profile-id", null);

    expect(result).toEqual({
      defaultUserProfileId: "user-profile-id",
      orgProfileId: null,
    });
  });
});
