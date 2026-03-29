import { describe, it, expect } from "bun:test";
import {
  resolveProviderProfiles,
  type ResolveProviderProfilesDeps,
} from "../../src/services/connection-profiles.ts";
import type { FlowProviderRequirement } from "../../src/types/index.ts";

const TEST_ORG_ID = "test-org-id";

function createMockDeps(
  bindings: Record<string, string> = {},
): ResolveProviderProfilesDeps {
  return {
    getOrgProfileBindings: async () => bindings,
  };
}

describe("resolveProviderProfiles", () => {
  const gmail: FlowProviderRequirement = { id: "@test/gmail" };
  const clickup: FlowProviderRequirement = { id: "@test/clickup" };
  const stripe: FlowProviderRequirement = { id: "@test/stripe" };

  it("uses defaultUserProfileId for all providers when no org profile and no overrides", async () => {
    const deps = createMockDeps();
    const result = await resolveProviderProfiles(
      [gmail, clickup],
      "default-profile",
      undefined,
      undefined,
      TEST_ORG_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "default-profile", source: "user_profile" },
      "@test/clickup": { profileId: "default-profile", source: "user_profile" },
    });
  });

  it("applies per-provider override while others use default", async () => {
    const deps = createMockDeps();
    const overrides = { "@test/gmail": "gmail-override-profile" };

    const result = await resolveProviderProfiles(
      [gmail, clickup],
      "default-profile",
      overrides,
      undefined,
      TEST_ORG_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "gmail-override-profile", source: "user_profile" },
      "@test/clickup": { profileId: "default-profile", source: "user_profile" },
    });
  });

  it("uses org binding for bound providers and default for unbound", async () => {
    const deps = createMockDeps({
      "@test/gmail": "org-gmail-profile",
    });

    const result = await resolveProviderProfiles(
      [gmail, clickup],
      "default-profile",
      undefined,
      "org-profile-1",
      TEST_ORG_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "org-gmail-profile", source: "org_binding" },
      "@test/clickup": { profileId: "default-profile", source: "user_profile" },
    });
  });

  it("org binding wins over per-provider override for the same provider", async () => {
    const deps = createMockDeps({
      "@test/gmail": "org-gmail-profile",
    });
    const overrides = { "@test/gmail": "user-gmail-override" };

    const result = await resolveProviderProfiles(
      [gmail],
      "default-profile",
      overrides,
      "org-profile-1",
      TEST_ORG_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "org-gmail-profile", source: "org_binding" },
    });
  });

  it("per-provider override wins over default for unbound provider when org profile exists", async () => {
    const deps = createMockDeps({
      "@test/gmail": "org-gmail-profile",
    });
    const overrides = { "@test/clickup": "clickup-override-profile" };

    const result = await resolveProviderProfiles(
      [gmail, clickup],
      "default-profile",
      overrides,
      "org-profile-1",
      TEST_ORG_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "org-gmail-profile", source: "org_binding" },
      "@test/clickup": { profileId: "clickup-override-profile", source: "user_profile" },
    });
  });

  it("returns empty map for empty providers array", async () => {
    const deps = createMockDeps();
    const result = await resolveProviderProfiles(
      [],
      "default-profile",
      undefined,
      undefined,
      TEST_ORG_ID,
      deps,
    );

    expect(result).toEqual({});
  });

  it("does not call getOrgProfileBindings when orgProfileId is not provided", async () => {
    let called = false;
    const deps: ResolveProviderProfilesDeps = {
      getOrgProfileBindings: async () => {
        called = true;
        return {};
      },
    };

    await resolveProviderProfiles(
      [gmail],
      "default-profile",
      undefined,
      undefined,
      TEST_ORG_ID,
      deps,
    );

    expect(called).toBe(false);
  });

  it("does not call getOrgProfileBindings when orgProfileId is null", async () => {
    let called = false;
    const deps: ResolveProviderProfilesDeps = {
      getOrgProfileBindings: async () => {
        called = true;
        return {};
      },
    };

    await resolveProviderProfiles([gmail], "default-profile", undefined, null, TEST_ORG_ID, deps);

    expect(called).toBe(false);
  });

  it("calls getOrgProfileBindings with the provided orgProfileId", async () => {
    let receivedId: string | undefined;
    const deps: ResolveProviderProfilesDeps = {
      getOrgProfileBindings: async (id) => {
        receivedId = id;
        return {};
      },
    };

    await resolveProviderProfiles(
      [gmail],
      "default-profile",
      undefined,
      "org-profile-42",
      TEST_ORG_ID,
      deps,
    );

    expect(receivedId).toBe("org-profile-42");
  });

  it("handles full 3-layer scenario with multiple providers", async () => {
    const deps = createMockDeps({
      "@test/gmail": "org-gmail-profile",
      "@test/stripe": "org-stripe-profile",
    });
    const overrides = {
      "@test/gmail": "user-gmail-override",
      "@test/clickup": "user-clickup-override",
    };

    const result = await resolveProviderProfiles(
      [gmail, clickup, stripe],
      "default-profile",
      overrides,
      "org-profile-1",
      TEST_ORG_ID,
      deps,
    );

    expect(result).toEqual({
      // org binding wins over user override
      "@test/gmail": { profileId: "org-gmail-profile", source: "org_binding" },
      // user override wins over default (no org binding for clickup)
      "@test/clickup": { profileId: "user-clickup-override", source: "user_profile" },
      // org binding (no user override needed)
      "@test/stripe": { profileId: "org-stripe-profile", source: "org_binding" },
    });
  });

  it("org binding with deleted source profile still resolves to org_binding source", async () => {
    // When an org binding points to a profile whose connection was deleted,
    // resolveProviderProfiles still returns "org_binding" — the broken state
    // is detected downstream (connection status check, UI display).
    const deps = createMockDeps({
      "@test/gmail": "deleted-profile-id",
    });

    const result = await resolveProviderProfiles(
      [gmail, clickup],
      "default-profile",
      undefined,
      "org-profile-1",
      TEST_ORG_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "deleted-profile-id", source: "org_binding" },
      "@test/clickup": { profileId: "default-profile", source: "user_profile" },
    });
  });

  it("empty org bindings fall back to user profiles for all providers", async () => {
    // Org profile exists but has no bindings — all providers resolved via user path
    const deps = createMockDeps({});
    const overrides = { "@test/gmail": "gmail-override" };

    const result = await resolveProviderProfiles(
      [gmail, clickup],
      "default-profile",
      overrides,
      "org-profile-1",
      TEST_ORG_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "gmail-override", source: "user_profile" },
      "@test/clickup": { profileId: "default-profile", source: "user_profile" },
    });
  });
});
