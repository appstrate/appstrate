// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import {
  assertRunnableOnEngine,
  assertSubscriptionEngineIsolation,
  resolveCredentialDelivery,
  SubscriptionRequiresIsolationError,
  buildOauthSidecarLlm,
  UnrunnableOauthProviderError,
} from "../../../src/services/run-launcher/subscription-run-policy.ts";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import {
  registerModelProvider,
  resetModelProviders,
} from "../../../src/services/model-providers/registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import {
  registerOrchestrator,
  _resetOrchestratorRegistryForTesting,
} from "../../../src/services/orchestrator/registry.ts";

function fakeProvider(
  id: string,
  overrides: Partial<ModelProviderDefinition> = {},
): ModelProviderDefinition {
  return {
    providerId: id,
    displayName: id,
    iconUrl: id,
    apiShape: "openai-completions",
    defaultBaseUrl: "https://api.example.com",
    baseUrlOverridable: false,
    authMode: "api_key",
    featuredModels: [],
    ...overrides,
  };
}

// The provider→engine binding lives on the model-provider definition, read by
// the policy through the model-provider registry. Seed the two reference
// subscription providers so these pure-unit assertions have data to resolve.
beforeAll(() => {
  resetModelProviders();
  registerModelProvider(
    fakeProvider("claude-code", {
      authMode: "oauth2",
      subscriptionEngine: { engine: "claude" },
    }),
  );
});
afterAll(() => seedTestModelProviders());

describe("assertRunnableOnEngine", () => {
  it("allows claude-code (oauth credential) on the claude engine", () => {
    expect(() =>
      assertRunnableOnEngine({
        engine: "claude",
        providerId: "claude-code",
        isOauthCredential: true,
      }),
    ).not.toThrow();
  });

  it("allows any api-key credential on the pi engine", () => {
    expect(() =>
      assertRunnableOnEngine({ engine: "pi", providerId: "anthropic", isOauthCredential: false }),
    ).not.toThrow();
  });

  it("rejects an oauth-subscription provider that resolves to pi (no forging fallback)", () => {
    expect(() =>
      assertRunnableOnEngine({
        engine: "pi",
        providerId: "some-oauth-sub",
        isOauthCredential: true,
      }),
    ).toThrow(UnrunnableOauthProviderError);
  });
});

describe("buildOauthSidecarLlm", () => {
  it("builds the non-forging oauth config (bearer swap only, no wireFormat)", () => {
    const cfg = buildOauthSidecarLlm({
      baseUrl: "https://api.anthropic.com",
      credentialId: "cred_1",
    });
    expect(cfg).toEqual({
      authMode: "oauth",
      baseUrl: "https://api.anthropic.com",
      credentialId: "cred_1",
    });
    // No identity-header / system-prepend forging field exists on the config.
    expect("wireFormat" in cfg).toBe(false);
  });

  it("carries modelSwap through", () => {
    const modelSwap = { alias: "appstrate-small", real: "claude-haiku-4-5" };
    expect(buildOauthSidecarLlm({ baseUrl: "u", credentialId: "c", modelSwap })).toMatchObject({
      authMode: "oauth",
      modelSwap,
    });
  });
});

describe("assertSubscriptionEngineIsolation", () => {
  // The guard consumes the engine resolved by resolveCredentialDelivery
  // (claude → subscription engine, pi → API-key) and allowlists against the
  // orchestrator registry's `isolatesWorkloads` flag — any backend that
  // never declared isolation is refused, not just the known in-host mode.
  it("rejects a claude-code subscription run under the process orchestrator", () => {
    expect(() =>
      assertSubscriptionEngineIsolation({
        engine: "claude",
        providerId: "claude-code",
        orchestratorMode: "process",
      }),
    ).toThrow(SubscriptionRequiresIsolationError);
  });

  it("allows a claude-code subscription run under docker", () => {
    expect(() =>
      assertSubscriptionEngineIsolation({
        engine: "claude",
        providerId: "claude-code",
        orchestratorMode: "docker",
      }),
    ).not.toThrow();
  });

  it("allows a claude-code subscription run under a module-contributed isolating backend", () => {
    registerOrchestrator(
      "fake-isolated",
      {
        isolatesWorkloads: true,
        supportsSidecarOnly: false,
        create: () => ({}) as never,
      },
      "test",
    );
    try {
      expect(() =>
        assertSubscriptionEngineIsolation({
          engine: "claude",
          providerId: "claude-code",
          orchestratorMode: "fake-isolated",
        }),
      ).not.toThrow();
    } finally {
      _resetOrchestratorRegistryForTesting();
    }
  });

  it("fails closed: a backend that never declared isolation is refused", () => {
    // A future RUN_ADAPTER value that passed env validation but whose
    // registration forgot `isolatesWorkloads: true` must be refused by
    // default — the guard is an allowlist, not a denylist of known-bad modes.
    expect(() =>
      assertSubscriptionEngineIsolation({
        engine: "claude",
        providerId: "claude-code",
        orchestratorMode: "some-future-backend" as never,
      }),
    ).toThrow(SubscriptionRequiresIsolationError);
  });

  it("allows an API-key provider under either orchestrator mode", () => {
    expect(() =>
      assertSubscriptionEngineIsolation({
        engine: "pi",
        providerId: "openai",
        orchestratorMode: "process",
      }),
    ).not.toThrow();
    expect(() =>
      assertSubscriptionEngineIsolation({
        engine: "pi",
        providerId: "openai",
        orchestratorMode: "docker",
      }),
    ).not.toThrow();
  });
});

describe("resolveCredentialDelivery (single classification axis)", () => {
  // Seed the model-provider registry so the oauth-class flag (authMode:
  // "oauth2") resolves. registerModelProvider also contributes the
  // subscription-engine binding for providers that carry one, so both axes
  // come from the SAME registration — the drift this resolver eliminates.
  beforeAll(() => {
    resetModelProviders();
    registerModelProvider(
      fakeProvider("claude-code", {
        authMode: "oauth2",
        subscriptionEngine: { engine: "claude" },
      }),
    );
    // An oauth-class provider with NO official engine — the hard-refuse path.
    registerModelProvider(fakeProvider("oauth-no-engine", { authMode: "oauth2" }));
    registerModelProvider(fakeProvider("openai", { authMode: "api_key" }));
  });
  afterAll(() => {
    // Restore the canonical cross-file baseline (model-provider registry, which
    // carries each module's subscriptionEngine binding).
    seedTestModelProviders();
  });

  it("resolves an oauth subscription credential + engine from the registry (single source)", () => {
    const d = resolveCredentialDelivery({ providerId: "claude-code", hasCredentialId: true });
    expect(d.isOauthCredential).toBe(true);
    // The engine comes from the SAME registry entry the launcher reads.
    expect(d.engine).toBe("claude");
  });

  it("classifies an oauth-class credential with no official engine as oauth on pi — then hard-refuses", () => {
    const d = resolveCredentialDelivery({ providerId: "oauth-no-engine", hasCredentialId: true });
    expect(d.isOauthCredential).toBe(true);
    expect(d.engine).toBe("pi");
    // The launcher feeds this into assertRunnableOnEngine, which MUST refuse
    // (no forging fallback for an oauth credential without an official engine).
    expect(() =>
      assertRunnableOnEngine({
        engine: d.engine,
        providerId: "oauth-no-engine",
        isOauthCredential: d.isOauthCredential,
      }),
    ).toThrow(UnrunnableOauthProviderError);
  });

  it("classifies an api-key provider as non-oauth on pi", () => {
    const d = resolveCredentialDelivery({ providerId: "openai", hasCredentialId: true });
    expect(d.isOauthCredential).toBe(false);
    expect(d.engine).toBe("pi");
  });

  it("is not oauth-class when no credential id is present (e.g. unconfigured)", () => {
    const d = resolveCredentialDelivery({ providerId: "claude-code", hasCredentialId: false });
    // With no oauth credential it is NOT routed to oauth delivery.
    expect(d.isOauthCredential).toBe(false);
    // Engine still resolves from the registry regardless of credential presence.
    expect(d.engine).toBe("claude");
  });
});
