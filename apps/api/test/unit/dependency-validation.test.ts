// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ApiError } from "../../src/lib/errors.ts";
import {
  collectDependencyErrors,
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
    getConnectionStatus: async (provider, _profileId, _orgId, _credId) => ({
      provider,
      status: "connected" as const,
      scopesGranted: ["read", "write"],
    }),
    getProviderCredentialId: async () => "mock-credential-id",
    validateScopes: () => ({ sufficient: true, missing: [] }),
    ...overrides,
  };
}

describe("validateAgentDependencies", () => {
  it("succeeds when all providers are connected with sufficient scopes", async () => {
    const deps = createMockDeps();
    const providers = [{ id: "@test/gmail", scopes: ["read"] }, { id: "@test/clickup" }];
    const profiles = profileMap({ "@test/gmail": "profile-1", "@test/clickup": "profile-2" });

    await validateAgentDependencies(providers, profiles, "org-1", "app-1", deps);
  });

  it("throws when provider is not enabled", async () => {
    const deps = createMockDeps({ isProviderEnabled: async () => false });
    const providers = [{ id: "@test/gmail" }];
    const profiles = profileMap({ "@test/gmail": "profile-1" });

    try {
      await validateAgentDependencies(providers, profiles, "org-1", "app-1", deps);
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
      await validateAgentDependencies(providers, profiles, "org-1", "app-1", deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("dependency_not_satisfied");
      expect((err as ApiError).message).toContain("not connected");
    }
  });

  it("throws when provider connection status is not_connected", async () => {
    const deps = createMockDeps({
      getConnectionStatus: async (provider, _profileId, _orgId, _credId) => ({
        provider,
        status: "not_connected" as const,
      }),
    });
    const providers = [{ id: "@test/gmail" }];
    const profiles = profileMap({ "@test/gmail": "profile-1" });

    try {
      await validateAgentDependencies(providers, profiles, "org-1", "app-1", deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("dependency_not_satisfied");
      expect((err as ApiError).message).toContain("not connected");
    }
  });

  it("throws when provider needs reconnection", async () => {
    const deps = createMockDeps({
      getConnectionStatus: async (provider, _profileId, _orgId, _credId) => ({
        provider,
        status: "needs_reconnection" as const,
        scopesGranted: ["read"],
      }),
    });
    const providers = [{ id: "@test/gmail" }];
    const profiles = profileMap({ "@test/gmail": "profile-1" });

    try {
      await validateAgentDependencies(providers, profiles, "org-1", "app-1", deps);
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
      await validateAgentDependencies(providers, profiles, "org-1", "app-1", deps);
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

    await validateAgentDependencies(providers, profiles, "org-1", "app-1", deps);
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

    await validateAgentDependencies(providers, profiles, "org-1", "app-1", deps);
    expect(scopesCalled).toBe(false);
  });

  it("validates multiple providers in parallel", async () => {
    let statusCallCount = 0;
    const deps = createMockDeps({
      getConnectionStatus: async (provider, _profileId, _orgId, _credId) => {
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

    await validateAgentDependencies(providers, profiles, "org-1", "app-1", deps);
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

    await validateAgentDependencies(providers, profiles, "org-1", "app-1", deps);
    expect(enabledCallCount).toBe(2);
  });

  it("succeeds with empty providers list", async () => {
    const deps = createMockDeps();
    await validateAgentDependencies([], {}, "org-1", "app-1", deps);
  });

  it("works with org_binding source entries", async () => {
    const deps = createMockDeps();
    const providers = [{ id: "@test/gmail" }, { id: "@test/gdrive" }];
    const profiles: ProviderProfileMap = {
      "@test/gmail": { profileId: "user-profile-1", source: "user_profile" },
      "@test/gdrive": { profileId: "admin-profile-1", source: "app_binding" },
    };

    await validateAgentDependencies(providers, profiles, "org-1", "app-1", deps);
  });
});

describe("collectDependencyErrors — multi-scope-set dedup", () => {
  // Regression guard for the dedup invariants in `collectDependencyErrors`.
  // A single manifest may declare the same provider twice with different
  // scope sets (e.g. a core agent asking for `read` plus a delegated helper
  // asking for `read write`). Each stage of the collector has its own
  // dedup strategy — this suite pins each one so a future refactor can't
  // regress them silently:
  //
  //   1. `enabled` checks iterate `uniqueProviders` → one query per id
  //   2. `missing profile` set → one entry per id
  //   3. status errors (`not_connected`, `needs_reconnection`) gated by
  //      `statusErrorEmitted` → one entry per id
  //   4. scope checks iterate the FULL `providers` list — a provider
  //      declared twice with DIFFERENT missing-scope sets produces TWO
  //      scope-insufficient entries (by design: each requirement is its
  //      own violation, and the caller may want to see both).

  it("emits one provider_not_enabled per provider even when declared with multiple scope sets", async () => {
    let enabledCallCount = 0;
    const deps = createMockDeps({
      isProviderEnabled: async () => {
        enabledCallCount++;
        return false;
      },
    });
    const providers = [
      { id: "@test/gmail", scopes: ["read"] },
      { id: "@test/gmail", scopes: ["read", "write"] },
      { id: "@test/gmail", scopes: ["send"] },
    ];
    const profiles = profileMap({ "@test/gmail": "p1" });

    const errors = await collectDependencyErrors(providers, profiles, "org-1", "app-1", deps);
    expect(enabledCallCount).toBe(1);
    const enabledErrors = errors.filter((e) => e.code === "provider_not_enabled");
    expect(enabledErrors).toHaveLength(1);
    expect(enabledErrors[0]!.field).toBe("providers.@test/gmail");
  });

  it("emits one dependency_not_satisfied per provider when the profile is missing", async () => {
    const deps = createMockDeps();
    const providers = [
      { id: "@test/clickup", scopes: ["read"] },
      { id: "@test/clickup", scopes: ["write"] },
    ];
    const profiles: ProviderProfileMap = {};

    const errors = await collectDependencyErrors(providers, profiles, "org-1", "app-1", deps);
    const notSatisfied = errors.filter((e) => e.code === "dependency_not_satisfied");
    expect(notSatisfied).toHaveLength(1);
    expect(notSatisfied[0]!.field).toBe("providers.@test/clickup");
  });

  it("emits one not_connected per provider even when declared twice", async () => {
    let statusCallCount = 0;
    const deps = createMockDeps({
      getConnectionStatus: async (provider) => {
        statusCallCount++;
        return { provider, status: "not_connected" as const };
      },
    });
    const providers = [
      { id: "@test/stripe", scopes: ["read"] },
      { id: "@test/stripe", scopes: ["read", "write"] },
    ];
    const profiles = profileMap({ "@test/stripe": "p1" });

    const errors = await collectDependencyErrors(providers, profiles, "org-1", "app-1", deps);
    // One status query (deduped) — scope checks don't re-query.
    expect(statusCallCount).toBe(1);
    const notConnected = errors.filter((e) => e.code === "dependency_not_satisfied");
    expect(notConnected).toHaveLength(1);
  });

  it("emits one needs_reconnection per provider even when declared twice", async () => {
    const deps = createMockDeps({
      getConnectionStatus: async (provider) => ({
        provider,
        status: "needs_reconnection" as const,
        scopesGranted: ["read"],
      }),
    });
    const providers = [
      { id: "@test/gmail", scopes: ["read"] },
      { id: "@test/gmail", scopes: ["read", "write"] },
    ];
    const profiles = profileMap({ "@test/gmail": "p1" });

    const errors = await collectDependencyErrors(providers, profiles, "org-1", "app-1", deps);
    const needsRecon = errors.filter((e) => e.code === "needs_reconnection");
    expect(needsRecon).toHaveLength(1);
  });

  it("emits one scope_insufficient per distinct requirement (NOT deduped)", async () => {
    // Scope violations are per-requirement, not per-provider: two different
    // scope sets each missing a different scope yield two entries. This is
    // intentional — callers need to see every missing scope set to guide
    // reconnection UX.
    const deps = createMockDeps({
      validateScopes: (_granted, required) => ({
        sufficient: false,
        missing: required.filter((s) => s !== "read"),
      }),
    });
    const providers = [
      { id: "@test/gmail", scopes: ["read", "write"] },
      { id: "@test/gmail", scopes: ["read", "send"] },
    ];
    const profiles = profileMap({ "@test/gmail": "p1" });

    const errors = await collectDependencyErrors(providers, profiles, "org-1", "app-1", deps);
    const scopeErrors = errors.filter((e) => e.code === "scope_insufficient");
    expect(scopeErrors).toHaveLength(2);
    expect(scopeErrors[0]!.message).toContain("write");
    expect(scopeErrors[1]!.message).toContain("send");
  });

  it("runs one credential lookup per provider even when declared twice", async () => {
    let credentialCallCount = 0;
    const deps = createMockDeps({
      getProviderCredentialId: async () => {
        credentialCallCount++;
        return "cred-id";
      },
    });
    const providers = [
      { id: "@test/gmail", scopes: ["read"] },
      { id: "@test/gmail", scopes: ["write"] },
      { id: "@test/gmail", scopes: ["send"] },
    ];
    const profiles = profileMap({ "@test/gmail": "p1" });

    await collectDependencyErrors(providers, profiles, "org-1", "app-1", deps);
    expect(credentialCallCount).toBe(1);
  });
});
