// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import {
  registerSubscriptionEngine,
  resetSubscriptionEnginesForTesting,
} from "@appstrate/core/subscription-engines";
import {
  assertRunnableOnEngine,
  assertSubscriptionEngineIsolation,
  assertVendRunHasNoIntegrations,
  resolveCredentialDelivery,
  SubscriptionRequiresDockerError,
  VendRunIntegrationsError,
  buildOauthSidecarLlm,
  UnrunnableOauthProviderError,
} from "../../../src/services/run-launcher/subscription-run-policy.ts";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import {
  registerModelProvider,
  resetModelProviders,
} from "../../../src/services/model-providers/registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

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

// The engine registry is contributed at boot by the provider modules; seed the
// two reference bindings so these pure-unit assertions have data to resolve.
beforeAll(() => {
  resetSubscriptionEnginesForTesting();
  registerSubscriptionEngine({
    providerId: "claude-code",
    label: "Claude Code",
    engine: "claude",
    sidecarAuthMode: "oauth",
    nativeOutput: true,
  });
  registerSubscriptionEngine({
    providerId: "codex",
    label: "Codex",
    engine: "codex",
    sidecarAuthMode: "vend",
    egressAllowlist: ["chatgpt.com", "openai.com"],
  });
});
afterAll(() => resetSubscriptionEnginesForTesting());

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

  it("allows a codex oauth credential on the codex engine", () => {
    expect(() =>
      assertRunnableOnEngine({ engine: "codex", providerId: "codex", isOauthCredential: true }),
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
  it("rejects a claude-code subscription run under the process orchestrator", () => {
    expect(() =>
      assertSubscriptionEngineIsolation({
        providerId: "claude-code",
        orchestratorMode: "process",
      }),
    ).toThrow(SubscriptionRequiresDockerError);
  });

  it("rejects a codex subscription run under the process orchestrator", () => {
    expect(() =>
      assertSubscriptionEngineIsolation({ providerId: "codex", orchestratorMode: "process" }),
    ).toThrow(SubscriptionRequiresDockerError);
  });

  it("allows a claude-code subscription run under docker", () => {
    expect(() =>
      assertSubscriptionEngineIsolation({
        providerId: "claude-code",
        orchestratorMode: "docker",
      }),
    ).not.toThrow();
  });

  it("allows an API-key provider under either orchestrator mode", () => {
    expect(() =>
      assertSubscriptionEngineIsolation({ providerId: "openai", orchestratorMode: "process" }),
    ).not.toThrow();
    expect(() =>
      assertSubscriptionEngineIsolation({ providerId: "openai", orchestratorMode: "docker" }),
    ).not.toThrow();
  });
});

describe("assertVendRunHasNoIntegrations", () => {
  it("rejects a vend run that declares integrations (token-on-shared-network)", () => {
    expect(() =>
      assertVendRunHasNoIntegrations({ mode: "vend", providerId: "codex", integrationCount: 1 }),
    ).toThrow(VendRunIntegrationsError);
  });

  it("allows a vend run with no integrations", () => {
    expect(() =>
      assertVendRunHasNoIntegrations({ mode: "vend", providerId: "codex", integrationCount: 0 }),
    ).not.toThrow();
  });

  it("allows oauth / api_key runs with integrations (no real token in container)", () => {
    expect(() =>
      assertVendRunHasNoIntegrations({
        mode: "oauth",
        providerId: "claude-code",
        integrationCount: 3,
      }),
    ).not.toThrow();
    expect(() =>
      assertVendRunHasNoIntegrations({
        mode: "api_key",
        providerId: "openai",
        integrationCount: 3,
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
    resetSubscriptionEnginesForTesting();
    registerModelProvider(
      fakeProvider("claude-code", {
        authMode: "oauth2",
        subscriptionEngine: { engine: "claude", sidecarAuthMode: "oauth", nativeOutput: true },
      }),
    );
    registerModelProvider(
      fakeProvider("codex", {
        authMode: "oauth2",
        subscriptionEngine: {
          engine: "codex",
          sidecarAuthMode: "vend",
          egressAllowlist: ["chatgpt.com", "openai.com"],
        },
      }),
    );
    // An oauth-class provider with NO official engine — the hard-refuse path.
    registerModelProvider(fakeProvider("oauth-no-engine", { authMode: "oauth2" }));
    registerModelProvider(fakeProvider("openai", { authMode: "api_key" }));
  });
  afterAll(() => {
    // Restore the canonical cross-file baselines (both registries).
    seedTestModelProviders();
    resetSubscriptionEnginesForTesting();
    registerSubscriptionEngine({
      providerId: "claude-code",
      label: "Claude Code",
      engine: "claude",
      sidecarAuthMode: "oauth",
      nativeOutput: true,
    });
    registerSubscriptionEngine({
      providerId: "codex",
      label: "Codex",
      engine: "codex",
      sidecarAuthMode: "vend",
      egressAllowlist: ["chatgpt.com", "openai.com"],
    });
  });

  it("derives an oauth subscription engine's authMode from the registry (single source)", () => {
    const d = resolveCredentialDelivery({ providerId: "claude-code", hasCredentialId: true });
    expect(d.mode).toBe("oauth");
    expect(d.isOauthCredential).toBe(true);
    expect(d.engine).toBe("claude");
    // authMode comes from the SAME registry entry selectRunEngine reads.
    expect(d.subscriptionEngine?.sidecarAuthMode).toBe("oauth");
    expect(d.egressAllowlist).toBeUndefined();
  });

  it("derives vend mode + egress allowlist from the registry for codex", () => {
    const d = resolveCredentialDelivery({ providerId: "codex", hasCredentialId: true });
    expect(d.mode).toBe("vend");
    expect(d.isOauthCredential).toBe(true);
    expect(d.engine).toBe("codex");
    expect(d.egressAllowlist).toEqual(["chatgpt.com", "openai.com"]);
  });

  it("classifies an oauth-class credential with no official engine as oauth on pi — then hard-refuses", () => {
    const d = resolveCredentialDelivery({ providerId: "oauth-no-engine", hasCredentialId: true });
    expect(d.mode).toBe("oauth");
    expect(d.isOauthCredential).toBe(true);
    expect(d.engine).toBe("pi");
    expect(d.subscriptionEngine).toBeUndefined();
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

  it("classifies an api-key provider as api_key on pi, never oauth", () => {
    const d = resolveCredentialDelivery({ providerId: "openai", hasCredentialId: true });
    expect(d.mode).toBe("api_key");
    expect(d.isOauthCredential).toBe(false);
    expect(d.engine).toBe("pi");
    expect(d.egressAllowlist).toBeUndefined();
  });

  it("is not oauth-class when no credential id is present (e.g. unconfigured)", () => {
    const d = resolveCredentialDelivery({ providerId: "claude-code", hasCredentialId: false });
    expect(d.isOauthCredential).toBe(false);
    // Engine still resolves from the registry regardless of credential presence.
    expect(d.engine).toBe("claude");
    // With no oauth credential it is NOT routed to oauth delivery.
    expect(d.mode).toBe("api_key");
  });
});
