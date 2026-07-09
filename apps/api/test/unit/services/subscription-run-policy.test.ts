// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import {
  assertOauthRunIsolation,
  assertOauthRunNotAliased,
  resolveCredentialDelivery,
  OauthAliasedModelUnsupportedError,
  OauthRunRequiresIsolationError,
  buildOauthSidecarLlm,
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

describe("buildOauthSidecarLlm", () => {
  it("builds the bearer-swap oauth config (no forging field)", () => {
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

  it("carries no modelSwap — the oauth mode never rewrites the body", () => {
    const cfg = buildOauthSidecarLlm({ baseUrl: "u", credentialId: "c" });
    expect("modelSwap" in cfg).toBe(false);
  });
});

describe("assertOauthRunNotAliased", () => {
  it("rejects an aliased model on an oauth credential", () => {
    expect(() =>
      assertOauthRunNotAliased({
        isOauthCredential: true,
        aliased: true,
        providerId: "claude-code",
      }),
    ).toThrow(OauthAliasedModelUnsupportedError);
  });

  it("allows an un-aliased oauth model and any api_key alias", () => {
    expect(() =>
      assertOauthRunNotAliased({
        isOauthCredential: true,
        aliased: false,
        providerId: "claude-code",
      }),
    ).not.toThrow();
    expect(() =>
      assertOauthRunNotAliased({ isOauthCredential: false, aliased: true, providerId: "openai" }),
    ).not.toThrow();
  });
});

describe("assertOauthRunIsolation", () => {
  // An OAuth run's credential is swapped in by the sidecar, which only an
  // isolating orchestrator provisions — the guard allowlists against the
  // orchestrator registry's `isolatesWorkloads` flag.
  it("rejects an oauth run under the process orchestrator", () => {
    expect(() =>
      assertOauthRunIsolation({
        isOauthCredential: true,
        providerId: "claude-code",
        orchestratorMode: "process",
      }),
    ).toThrow(OauthRunRequiresIsolationError);
  });

  it("allows an oauth run under docker", () => {
    expect(() =>
      assertOauthRunIsolation({
        isOauthCredential: true,
        providerId: "claude-code",
        orchestratorMode: "docker",
      }),
    ).not.toThrow();
  });

  it("allows an oauth run under a module-contributed isolating backend", () => {
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
        assertOauthRunIsolation({
          isOauthCredential: true,
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
      assertOauthRunIsolation({
        isOauthCredential: true,
        providerId: "claude-code",
        orchestratorMode: "some-future-backend" as never,
      }),
    ).toThrow(OauthRunRequiresIsolationError);
  });

  it("allows a non-oauth (API-key) run under either orchestrator mode", () => {
    expect(() =>
      assertOauthRunIsolation({
        isOauthCredential: false,
        providerId: "openai",
        orchestratorMode: "process",
      }),
    ).not.toThrow();
    expect(() =>
      assertOauthRunIsolation({
        isOauthCredential: false,
        providerId: "openai",
        orchestratorMode: "docker",
      }),
    ).not.toThrow();
  });
});

describe("resolveCredentialDelivery (oauth-class classification)", () => {
  // Seed the model-provider registry so the oauth-class flag (authMode:
  // "oauth2") resolves off the same registration the launcher reads.
  beforeAll(() => {
    resetModelProviders();
    registerModelProvider(fakeProvider("claude-code", { authMode: "oauth2" }));
    registerModelProvider(fakeProvider("codex", { authMode: "oauth2" }));
    registerModelProvider(fakeProvider("openai", { authMode: "api_key" }));
  });
  afterAll(() => {
    seedTestModelProviders();
  });

  it("classifies an oauth subscription credential as oauth-class (delivered via sidecar swap)", () => {
    expect(
      resolveCredentialDelivery({ providerId: "claude-code", hasCredentialId: true })
        .isOauthCredential,
    ).toBe(true);
    // codex is now oauth-class and runs on Pi like claude-code (no refuse path).
    expect(
      resolveCredentialDelivery({ providerId: "codex", hasCredentialId: true }).isOauthCredential,
    ).toBe(true);
  });

  it("classifies an api-key provider as non-oauth", () => {
    expect(
      resolveCredentialDelivery({ providerId: "openai", hasCredentialId: true }).isOauthCredential,
    ).toBe(false);
  });

  it("is not oauth-class when no credential id is present (e.g. unconfigured)", () => {
    expect(
      resolveCredentialDelivery({ providerId: "claude-code", hasCredentialId: false })
        .isOauthCredential,
    ).toBe(false);
  });
});
