import { describe, test, expect, mock, beforeEach } from "bun:test";
import { queues, resetQueues, tracking, db, schemaStubs } from "./_db-mock.ts";

// --- Mocks (must be before dynamic import) ---

const noop = () => {};
mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));
mock.module("@appstrate/db/schema", () => schemaStubs);

// Mock getAdminConnections from state service
let mockAdminConnections: Record<string, string> = {};
mock.module("../state/index.ts", () => ({
  getAdminConnections: async () => mockAdminConnections,
}));

// --- Dynamic imports (after mocks) ---

const {
  ensureDefaultProfile,
  listProfiles,
  getProfileForActor,
  createProfile,
  deleteProfile,
  setPackageProfileOverride,
  getEffectiveProfileId,
  resolveProviderProfiles,
} = await import("../connection-profiles.ts");

// --- Helpers ---

const memberActor = { type: "member" as const, id: "user-1" };
const endUserActor = { type: "end_user" as const, id: "eu-1" };

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "profile-1",
    userId: "user-1",
    endUserId: null,
    name: "Default",
    isDefault: true,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

// --- Tests ---

beforeEach(() => {
  resetQueues();
  mockAdminConnections = {};
});

describe("ensureDefaultProfile", () => {
  test("creates profile for member actor when none exists", async () => {
    // First select returns empty (no existing default)
    queues.select.push([]);
    // Insert returning the created profile
    const created = makeProfile();
    queues.insert.push([created]);

    const result = await ensureDefaultProfile(memberActor);

    expect(result).toEqual(created);
    expect(tracking.insertCalls[0]).toMatchObject({
      userId: "user-1",
      endUserId: null,
      name: "Default",
      isDefault: true,
    });
  });

  test("creates profile for end_user actor when none exists", async () => {
    queues.select.push([]);
    const created = makeProfile({ userId: null, endUserId: "eu-1" });
    queues.insert.push([created]);

    const result = await ensureDefaultProfile(endUserActor);

    expect(result).toEqual(created);
    expect(tracking.insertCalls[0]).toMatchObject({
      userId: null,
      endUserId: "eu-1",
      name: "Default",
      isDefault: true,
    });
  });

  test("returns existing profile if one exists (idempotent)", async () => {
    const existing = makeProfile();
    queues.select.push([existing]);

    const result = await ensureDefaultProfile(memberActor);

    expect(result).toEqual(existing);
    // No insert should have been called
    expect(tracking.insertCalls).toHaveLength(0);
  });
});

describe("listProfiles", () => {
  test("filters by member actor (userId)", async () => {
    const profiles = [
      { ...makeProfile(), connectionCount: 2 },
      { ...makeProfile({ id: "profile-2", name: "Work", isDefault: false }), connectionCount: 0 },
    ];
    queues.select.push(profiles);

    const result = await listProfiles(memberActor);

    expect(result).toHaveLength(2);
    expect(result[0]!.connectionCount).toBe(2);
    expect(result[1]!.name).toBe("Work");
  });

  test("filters by end_user actor (endUserId)", async () => {
    const profiles = [
      {
        ...makeProfile({ userId: null, endUserId: "eu-1" }),
        connectionCount: 1,
      },
    ];
    queues.select.push(profiles);

    const result = await listProfiles(endUserActor);

    expect(result).toHaveLength(1);
    expect(result[0]!.endUserId).toBe("eu-1");
  });
});

describe("getProfileForActor", () => {
  test("returns profile matching actor", async () => {
    const profile = makeProfile();
    queues.select.push([profile]);

    const result = await getProfileForActor("profile-1", memberActor);

    expect(result).toEqual(profile);
  });

  test("returns null for wrong actor", async () => {
    queues.select.push([]);

    const result = await getProfileForActor("profile-1", memberActor);

    expect(result).toBeNull();
  });
});

describe("createProfile", () => {
  test("creates with correct actor fields for member", async () => {
    const created = makeProfile({ name: "Work", isDefault: false });
    queues.insert.push([created]);

    const result = await createProfile(memberActor, "Work");

    expect(result).toEqual(created);
    expect(tracking.insertCalls[0]).toMatchObject({
      userId: "user-1",
      endUserId: null,
      name: "Work",
      isDefault: false,
    });
  });

  test("creates with correct actor fields for end_user", async () => {
    const created = makeProfile({
      userId: null,
      endUserId: "eu-1",
      name: "Custom",
      isDefault: false,
    });
    queues.insert.push([created]);

    const result = await createProfile(endUserActor, "Custom");

    expect(result).toEqual(created);
    expect(tracking.insertCalls[0]).toMatchObject({
      userId: null,
      endUserId: "eu-1",
      name: "Custom",
      isDefault: false,
    });
  });
});

describe("deleteProfile", () => {
  test("deletes non-default profile successfully", async () => {
    const profile = makeProfile({ isDefault: false });
    // First select: find the profile
    queues.select.push([profile]);

    await expect(deleteProfile("profile-1", memberActor)).resolves.toBeUndefined();
    expect(tracking.deleteCalls).toHaveLength(1);
  });

  test("throws if profile not found", async () => {
    queues.select.push([]);

    await expect(deleteProfile("missing", memberActor)).rejects.toThrow("Profile not found");
  });

  test("throws if trying to delete default profile", async () => {
    const profile = makeProfile({ isDefault: true });
    queues.select.push([profile]);

    await expect(deleteProfile("profile-1", memberActor)).rejects.toThrow(
      "Cannot delete the default profile",
    );
  });
});

describe("setPackageProfileOverride", () => {
  test("creates new override when none exists", async () => {
    // SELECT returns empty (no existing override)
    queues.select.push([]);

    await setPackageProfileOverride(memberActor, "pkg-1", "profile-2");

    // Should have inserted
    expect(tracking.insertCalls).toHaveLength(1);
    expect(tracking.insertCalls[0]).toMatchObject({
      userId: "user-1",
      endUserId: null,
      packageId: "pkg-1",
      profileId: "profile-2",
    });
    // No update calls
    expect(tracking.updateCalls).toHaveLength(0);
  });

  test("updates existing override", async () => {
    // SELECT returns existing override
    queues.select.push([{ id: "override-1" }]);

    await setPackageProfileOverride(memberActor, "pkg-1", "profile-3");

    // Should have updated, not inserted
    expect(tracking.updateCalls).toHaveLength(1);
    expect(tracking.updateCalls[0]).toMatchObject({
      profileId: "profile-3",
    });
    expect(tracking.insertCalls).toHaveLength(0);
  });
});

describe("getEffectiveProfileId", () => {
  test("returns override profileId when set", async () => {
    // First select: override lookup returns a match
    queues.select.push([{ profileId: "override-profile" }]);

    const result = await getEffectiveProfileId(memberActor, "pkg-1");

    expect(result).toBe("override-profile");
  });

  test("returns default when no override", async () => {
    // First select: override lookup returns empty
    queues.select.push([]);
    // Second select: ensureDefaultProfile finds existing default
    const defaultProfile = makeProfile({ id: "default-profile" });
    queues.select.push([defaultProfile]);

    const result = await getEffectiveProfileId(memberActor, "pkg-1");

    expect(result).toBe("default-profile");
  });

  test("returns default when no packageId provided", async () => {
    // ensureDefaultProfile finds existing default
    const defaultProfile = makeProfile({ id: "default-profile" });
    queues.select.push([defaultProfile]);

    const result = await getEffectiveProfileId(memberActor);

    expect(result).toBe("default-profile");
  });
});

describe("resolveProviderProfiles", () => {
  test("resolves admin connection vs user connection modes", async () => {
    // getEffectiveProfileId: override lookup empty, then ensureDefaultProfile
    queues.select.push([]); // no override
    queues.select.push([makeProfile({ id: "user-profile" })]); // default profile

    mockAdminConnections = { gmail: "admin-profile-1" };

    const providers = [
      { id: "gmail", provider: "gmail", connectionMode: "admin" as const },
      { id: "clickup", provider: "clickup", connectionMode: "user" as const },
      { id: "slack", provider: "slack" }, // defaults to "user"
    ];

    const result = await resolveProviderProfiles(providers, memberActor, "pkg-1", "org-1");

    expect(result).toEqual({
      gmail: "admin-profile-1",
      clickup: "user-profile",
      slack: "user-profile",
    });
  });

  test("skips admin providers without admin connection", async () => {
    queues.select.push([]);
    queues.select.push([makeProfile({ id: "user-profile" })]);

    mockAdminConnections = {}; // no admin connections configured

    const providers = [
      { id: "gmail", provider: "gmail", connectionMode: "admin" as const },
      { id: "clickup", provider: "clickup", connectionMode: "user" as const },
    ];

    const result = await resolveProviderProfiles(providers, memberActor, "pkg-1", "org-1");

    // gmail not included since no admin connection
    expect(result).toEqual({
      clickup: "user-profile",
    });
  });

  test("uses profileIdOverride when provided", async () => {
    mockAdminConnections = {};

    const providers = [{ id: "clickup", provider: "clickup", connectionMode: "user" as const }];

    const result = await resolveProviderProfiles(
      providers,
      memberActor,
      "pkg-1",
      "org-1",
      "explicit-profile-id",
    );

    expect(result).toEqual({
      clickup: "explicit-profile-id",
    });
  });
});
