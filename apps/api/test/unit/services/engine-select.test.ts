// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  selectRunEngine,
  assertRunnableOnEngine,
  buildOauthSidecarLlm,
  UnrunnableOauthProviderError,
} from "../../../src/services/run-launcher/engine-select.ts";

describe("selectRunEngine", () => {
  it("routes claude-code to the Claude engine (official Agent SDK)", () => {
    expect(selectRunEngine({ providerId: "claude-code" })).toBe("claude");
  });

  it("routes every other provider to Pi", () => {
    // anthropic (api-key) shares the apiShape but must stay on Pi.
    for (const providerId of ["anthropic", "openai", "codex", "openai-compatible"]) {
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

  it("rejects an oauth-subscription provider that resolves to pi (no forging fallback)", () => {
    expect(() =>
      assertRunnableOnEngine({ engine: "pi", providerId: "codex", isOauthCredential: true }),
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
