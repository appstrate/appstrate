// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  engineForProvider,
  providerHasNativeOutput,
  isSubscriptionEngine,
  registerSubscriptionEngine,
  resetSubscriptionEnginesForTesting,
  subscriptionEngineDef,
} from "../src/subscription-engines.ts";

// Core ships ZERO subscription bindings — the registry is contributed at boot
// by the opt-in provider modules. Seed the two reference bindings the way
// `registerModelProvider` does, so the read functions have data to resolve.
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

describe("registry is empty until contributed", () => {
  it("resolves everything to pi before any registration", () => {
    resetSubscriptionEnginesForTesting();
    expect(engineForProvider("claude-code")).toBe("pi");
    expect(engineForProvider("codex")).toBe("pi");
    expect(subscriptionEngineDef("claude-code")).toBeUndefined();
    // Re-seed for the rest of the suite (beforeAll already ran once).
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

  it("rejects a conflicting re-registration (same id, different engine)", () => {
    expect(() =>
      registerSubscriptionEngine({
        providerId: "claude-code",
        label: "Claude Code",
        engine: "codex",
        sidecarAuthMode: "oauth",
      }),
    ).toThrow();
  });
});

describe("engineForProvider", () => {
  it("maps the contributed subscription providers to their engines", () => {
    expect(engineForProvider("claude-code")).toBe("claude");
    expect(engineForProvider("codex")).toBe("codex");
  });
  it("falls back to pi for any API-key / unknown provider", () => {
    expect(engineForProvider("openai")).toBe("pi");
    expect(engineForProvider("anthropic")).toBe("pi");
    expect(engineForProvider("")).toBe("pi");
  });
});

describe("subscriptionEngineDef", () => {
  it("exposes the codex egress allowlist (in-container token → locked hosts)", () => {
    expect(subscriptionEngineDef("codex")?.egressAllowlist).toEqual(["chatgpt.com", "openai.com"]);
  });
  it("claude has no egress allowlist (token swapped server-side, never in-container)", () => {
    expect(subscriptionEngineDef("claude-code")?.egressAllowlist).toBeUndefined();
  });
  it("returns undefined for a non-subscription provider", () => {
    expect(subscriptionEngineDef("openai")).toBeUndefined();
  });
  it("carries a human label for each subscription engine", () => {
    expect(subscriptionEngineDef("claude-code")?.label).toBe("Claude Code");
    expect(subscriptionEngineDef("codex")?.label).toBe("Codex");
  });
});

describe("isSubscriptionEngine", () => {
  it("is true for the vendor-binary engines, false for pi", () => {
    expect(isSubscriptionEngine("claude")).toBe(true);
    expect(isSubscriptionEngine("codex")).toBe(true);
    expect(isSubscriptionEngine("pi")).toBe(false);
  });
});

describe("providerHasNativeOutput", () => {
  it("is true only for a provider that materialises output natively (claude-code)", () => {
    expect(providerHasNativeOutput("claude-code")).toBe(true);
  });
  it("is false for a provider that takes output through the MCP tool (codex)", () => {
    expect(providerHasNativeOutput("codex")).toBe(false);
  });
  it("is false for an unregistered / API-key provider", () => {
    expect(providerHasNativeOutput("openai")).toBe(false);
    expect(providerHasNativeOutput("")).toBe(false);
  });
});
