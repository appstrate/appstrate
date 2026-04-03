// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../src/lib/errors.ts";
import {
  validateAgentDependencies,
  type DependencyValidationDeps,
} from "../../src/services/dependency-validation.ts";
import type { ProviderProfileMap } from "../../src/types/index.ts";

/** Helper to build a ProviderProfileMap from simple id → profileId pairs. */
function profileMap(entries: Record<string, string>): ProviderProfileMap {
  const map: ProviderProfileMap = {};
  for (const [id, profileId] of Object.entries(entries)) {
    map[id] = { profileId, source: "user_profile" };
  }
  return map;
}

function createMockDeps(overrides?: Partial<DependencyValidationDeps>): DependencyValidationDeps {
  return {
    isProviderEnabled: async () => true,
    getConnectionStatus: async (provider) => ({
      provider,
      status: "connected" as const,
      scopesGranted: ["read", "write"],
    }),
    validateScopes: () => ({ sufficient: true, missing: [] }),
    ...overrides,
  };
}

describe("validateAgentDependencies", () => {
  it("succeeds when all providers are connected with sufficient scopes", async () => {
    const deps = createMockDeps();
    const providers = [{ id: "@test/gmail", scopes: ["read"] }, { id: "@test/clickup" }];
    const profiles = profileMap({ "@test/gmail": "profile-1", "@test/clickup": "profile-2" });

    await validateAgentDependencies(providers, profiles, "org-1", deps);
  });

  it("throws when provider is not enabled", async () => {
    const deps = createMockDeps({ isProviderEnabled: async () => false });
    const providers = [{ id: "@test/gmail" }];
    const profiles = profileMap({ "@test/gmail": "profile-1" });

    try {
      await validateAgentDependencies(providers, profiles, "org-1", deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("provider_not_enabled");
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toContain("@test/gmail");
    }
  });

  it("throws when profile is missing for provider", async () => {
    const deps = createMockDeps();
    const providers = [{ id: "@test/gmail" }];
    const profiles: ProviderProfileMap = {};

    try {
      await validateAgentDependencies(providers, profiles, "org-1", deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("dependency_not_satisfied");
      expect((err as ApiError).message).toContain("not connected");
    }
  });

  it("throws when provider connection status is not_connected", async () => {
    const deps = createMockDeps({
      getConnectionStatus: async (provider) => ({
        provider,
        status: "not_connected" as const,
      }),
    });
    const providers = [{ id: "@test/gmail" }];
    const profiles = profileMap({ "@test/gmail": "profile-1" });

    try {
      await validateAgentDependencies(providers, profiles, "org-1", deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("dependency_not_satisfied");
      expect((err as ApiError).message).toContain("not connected");
    }
  });

  it("throws when provider needs reconnection", async () => {
    const deps = createMockDeps({
      getConnectionStatus: async (provider) => ({
        provider,
        status: "needs_reconnection" as const,
        scopesGranted: ["read"],
      }),
    });
    const providers = [{ id: "@test/gmail" }];
    const profiles = profileMap({ "@test/gmail": "profile-1" });

    try {
      await validateAgentDependencies(providers, profiles, "org-1", deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("needs_reconnection");
    }
  });

  it("throws when scopes are insufficient", async () => {
    const deps = createMockDeps({
      validateScopes: () => ({ sufficient: false, missing: ["write"] }),
    });
    const providers = [{ id: "@test/gmail", scopes: ["read", "write"] }];
    const profiles = profileMap({ "@test/gmail": "profile-1" });

    try {
      await validateAgentDependencies(providers, profiles, "org-1", deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("scope_insufficient");
      expect((err as ApiError).message).toContain("write");
    }
  });

  it("skips scope validation when provider has no required scopes", async () => {
    let scopesCalled = false;
    const deps = createMockDeps({
      validateScopes: () => {
        scopesCalled = true;
        return { sufficient: true, missing: [] };
      },
    });
    const providers = [{ id: "@test/gmail" }];
    const profiles = profileMap({ "@test/gmail": "profile-1" });

    await validateAgentDependencies(providers, profiles, "org-1", deps);
    expect(scopesCalled).toBe(false);
  });

  it("skips scope validation when scopes array is empty", async () => {
    let scopesCalled = false;
    const deps = createMockDeps({
      validateScopes: () => {
        scopesCalled = true;
        return { sufficient: true, missing: [] };
      },
    });
    const providers = [{ id: "@test/gmail", scopes: [] }];
    const profiles = profileMap({ "@test/gmail": "profile-1" });

    await validateAgentDependencies(providers, profiles, "org-1", deps);
    expect(scopesCalled).toBe(false);
  });

  it("validates multiple providers in parallel", async () => {
    let statusCallCount = 0;
    const deps = createMockDeps({
      getConnectionStatus: async (provider) => {
        statusCallCount++;
        return { provider, status: "connected" as const, scopesGranted: [] };
      },
    });
    const providers = [{ id: "@test/gmail" }, { id: "@test/clickup" }, { id: "@test/stripe" }];
    const profiles = profileMap({
      "@test/gmail": "p1",
      "@test/clickup": "p2",
      "@test/stripe": "p3",
    });

    await validateAgentDependencies(providers, profiles, "org-1", deps);
    expect(statusCallCount).toBe(3);
  });

  it("deduplicates provider enabled checks for identical IDs", async () => {
    let enabledCallCount = 0;
    const deps = createMockDeps({
      isProviderEnabled: async () => {
        enabledCallCount++;
        return true;
      },
    });
    const providers = [{ id: "@test/gmail" }, { id: "@test/clickup" }];
    const profiles = profileMap({ "@test/gmail": "p1", "@test/clickup": "p2" });

    await validateAgentDependencies(providers, profiles, "org-1", deps);
    expect(enabledCallCount).toBe(2);
  });

  it("succeeds with empty providers list", async () => {
    const deps = createMockDeps();
    await validateAgentDependencies([], {}, "org-1", deps);
  });

  it("works with org_binding source entries", async () => {
    const deps = createMockDeps();
    const providers = [{ id: "@test/gmail" }, { id: "@test/gdrive" }];
    const profiles: ProviderProfileMap = {
      "@test/gmail": { profileId: "user-profile-1", source: "user_profile" },
      "@test/gdrive": { profileId: "admin-profile-1", source: "org_binding" },
    };

    await validateAgentDependencies(providers, profiles, "org-1", deps);
  });
});
