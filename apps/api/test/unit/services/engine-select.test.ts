// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import {
  registerSubscriptionEngine,
  resetSubscriptionEnginesForTesting,
} from "@appstrate/core/subscription-engines";
import {
  selectRunEngine,
  assertRunnableOnEngine,
  assertSubscriptionEngineIsolation,
  SubscriptionRequiresDockerError,
  buildOauthSidecarLlm,
  UnrunnableOauthProviderError,
} from "../../../src/services/run-launcher/engine-select.ts";

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

describe("selectRunEngine", () => {
  it("routes claude-code to the Claude engine (official Agent SDK)", () => {
    expect(selectRunEngine({ providerId: "claude-code" })).toBe("claude");
  });

  it("routes codex to the Codex engine (official Codex CLI)", () => {
    expect(selectRunEngine({ providerId: "codex" })).toBe("codex");
  });

  it("routes every api-key provider to Pi", () => {
    // anthropic (api-key) shares the apiShape but must stay on Pi.
    for (const providerId of ["anthropic", "openai", "openai-compatible"]) {
      expect(selectRunEngine({ providerId })).toBe("pi");
    }
  });
});

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
