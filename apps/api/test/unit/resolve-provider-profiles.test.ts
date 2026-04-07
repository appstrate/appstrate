// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  resolveProviderProfiles,
  type ResolveProviderProfilesDeps,
} from "../../src/services/connection-profiles.ts";
import type { AgentProviderRequirement } from "../../src/types/index.ts";

const TEST_APP_ID = "test-app-id";

function createMockDeps(bindings: Record<string, string> = {}): ResolveProviderProfilesDeps {
  return {
    getAppProfileBindings: async () => bindings,
  };
}

describe("resolveProviderProfiles", () => {
  const gmail: AgentProviderRequirement = { id: "@test/gmail" };
  const clickup: AgentProviderRequirement = { id: "@test/clickup" };
  const stripe: AgentProviderRequirement = { id: "@test/stripe" };

  it("uses defaultUserProfileId for all providers when no app profile and no overrides", async () => {
    const deps = createMockDeps();
    const result = await resolveProviderProfiles(
      [gmail, clickup],
      "default-profile",
      undefined,
      undefined,
      TEST_APP_ID,
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
      TEST_APP_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "gmail-override-profile", source: "user_profile" },
      "@test/clickup": { profileId: "default-profile", source: "user_profile" },
    });
  });

  it("uses app binding for bound providers and default for unbound", async () => {
    const deps = createMockDeps({
      "@test/gmail": "org-gmail-profile",
    });

    const result = await resolveProviderProfiles(
      [gmail, clickup],
      "default-profile",
      undefined,
      "app-profile-1",
      TEST_APP_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "org-gmail-profile", source: "app_binding" },
      "@test/clickup": { profileId: "default-profile", source: "user_profile" },
    });
  });

  it("app binding wins over per-provider override for the same provider", async () => {
    const deps = createMockDeps({
      "@test/gmail": "org-gmail-profile",
    });
    const overrides = { "@test/gmail": "user-gmail-override" };

    const result = await resolveProviderProfiles(
      [gmail],
      "default-profile",
      overrides,
      "app-profile-1",
      TEST_APP_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "org-gmail-profile", source: "app_binding" },
    });
  });

  it("per-provider override wins over default for unbound provider when app profile exists", async () => {
    const deps = createMockDeps({
      "@test/gmail": "org-gmail-profile",
    });
    const overrides = { "@test/clickup": "clickup-override-profile" };

    const result = await resolveProviderProfiles(
      [gmail, clickup],
      "default-profile",
      overrides,
      "app-profile-1",
      TEST_APP_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "org-gmail-profile", source: "app_binding" },
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
      TEST_APP_ID,
      deps,
    );

    expect(result).toEqual({});
  });

  it("does not call getAppProfileBindings when appProfileId is not provided", async () => {
    let called = false;
    const deps: ResolveProviderProfilesDeps = {
      getAppProfileBindings: async () => {
        called = true;
        return {};
      },
    };

    await resolveProviderProfiles(
      [gmail],
      "default-profile",
      undefined,
      undefined,
      TEST_APP_ID,
      deps,
    );

    expect(called).toBe(false);
  });

  it("does not call getAppProfileBindings when appProfileId is null", async () => {
    let called = false;
    const deps: ResolveProviderProfilesDeps = {
      getAppProfileBindings: async () => {
        called = true;
        return {};
      },
    };

    await resolveProviderProfiles([gmail], "default-profile", undefined, null, TEST_APP_ID, deps);

    expect(called).toBe(false);
  });

  it("calls getAppProfileBindings with the provided appProfileId", async () => {
    let receivedId: string | undefined;
    const deps: ResolveProviderProfilesDeps = {
      getAppProfileBindings: async (id) => {
        receivedId = id;
        return {};
      },
    };

    await resolveProviderProfiles(
      [gmail],
      "default-profile",
      undefined,
      "app-profile-42",
      TEST_APP_ID,
      deps,
    );

    expect(receivedId).toBe("app-profile-42");
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
      "app-profile-1",
      TEST_APP_ID,
      deps,
    );

    expect(result).toEqual({
      // app binding wins over user override
      "@test/gmail": { profileId: "org-gmail-profile", source: "app_binding" },
      // user override wins over default (no org binding for clickup)
      "@test/clickup": { profileId: "user-clickup-override", source: "user_profile" },
      // app binding (no user override needed)
      "@test/stripe": { profileId: "org-stripe-profile", source: "app_binding" },
    });
  });

  it("app binding with deleted source profile still resolves to app_binding source", async () => {
    // When an app binding points to a profile whose connection was deleted,
    // resolveProviderProfiles still returns "app_binding" — the broken state
    // is detected downstream (connection status check, UI display).
    const deps = createMockDeps({
      "@test/gmail": "deleted-profile-id",
    });

    const result = await resolveProviderProfiles(
      [gmail, clickup],
      "default-profile",
      undefined,
      "app-profile-1",
      TEST_APP_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "deleted-profile-id", source: "app_binding" },
      "@test/clickup": { profileId: "default-profile", source: "user_profile" },
    });
  });

  it("omits provider from map when defaultUserProfileId is null and no app bindings or overrides", async () => {
    const deps = createMockDeps();
    const result = await resolveProviderProfiles(
      [gmail, clickup],
      null,
      undefined,
      undefined,
      TEST_APP_ID,
      deps,
    );

    expect(result).toEqual({});
  });

  it("empty app bindings fall back to user profiles for all providers", async () => {
    // App profile exists but has no bindings — all providers resolved via user path
    const deps = createMockDeps({});
    const overrides = { "@test/gmail": "gmail-override" };

    const result = await resolveProviderProfiles(
      [gmail, clickup],
      "default-profile",
      overrides,
      "app-profile-1",
      TEST_APP_ID,
      deps,
    );

    expect(result).toEqual({
      "@test/gmail": { profileId: "gmail-override", source: "user_profile" },
      "@test/clickup": { profileId: "default-profile", source: "user_profile" },
    });
  });
});
