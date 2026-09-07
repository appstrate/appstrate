// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import coreProvidersModule from "../../index.ts";

describe("core-providers module", () => {
  it("declares the canonical API-key provider catalog", () => {
    const ids = coreProvidersModule
      .modelProviders?.()
      .map((p) => p.providerId)
      .sort();
    expect(ids).toEqual([
      "anthropic",
      "anthropic-compatible",
      "cerebras",
      "deepseek",
      "fireworks-ai",
      "google-ai",
      "groq",
      "mistral",
      "moonshot",
      "openai",
      "openai-compatible",
      "opencode-go",
      "openrouter",
      "together-ai",
      "xai",
      "zai",
    ]);
  });

  it("every contributed provider is api_key and has no oauth block", () => {
    for (const def of coreProvidersModule.modelProviders?.() ?? []) {
      expect(def.authMode).toBe("api_key");
      expect(def.oauth).toBeUndefined();
    }
  });

  it("offers at most one custom endpoint per wire format", () => {
    // A `baseUrlOverridable` entry exists to reach an endpoint no named preset
    // covers, and what distinguishes one from another is the wire format —
    // two sharing an apiShape could not be told apart when a credential's
    // (apiShape, baseUrl) is resolved back to its provider.
    const shapes = (coreProvidersModule.modelProviders?.() ?? [])
      .filter((p) => p.baseUrlOverridable)
      .map((p) => p.apiShape);
    expect(shapes.length).toBeGreaterThan(0);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("pins each provider to its canonical apiShape", () => {
    const byId = new Map(
      (coreProvidersModule.modelProviders?.() ?? []).map((p) => [p.providerId, p]),
    );
    expect(byId.get("openai")?.apiShape).toBe("openai-responses");
    expect(byId.get("anthropic")?.apiShape).toBe("anthropic-messages");
    expect(byId.get("openai-compatible")?.apiShape).toBe("openai-completions");
    expect(byId.get("anthropic-compatible")?.apiShape).toBe("anthropic-messages");
    expect(byId.get("mistral")?.apiShape).toBe("mistral-conversations");
    expect(byId.get("google-ai")?.apiShape).toBe("google-generative-ai");
    expect(byId.get("groq")?.apiShape).toBe("openai-completions");
    expect(byId.get("cerebras")?.apiShape).toBe("openai-completions");
    expect(byId.get("xai")?.apiShape).toBe("openai-completions");
    expect(byId.get("openrouter")?.apiShape).toBe("openai-completions");
  });

  it("init is a no-op (declarative contribution)", async () => {
    // `services` cast: the module's init() ignores ctx entirely, so the
    // PlatformServices subtree is never read — using `as never` keeps the
    // test self-contained without dragging in the full PlatformServices
    // construction surface from @appstrate/core/module.
    await expect(
      coreProvidersModule.init({
        redisUrl: null,
        appUrl: "http://localhost:3000",
        getSendMail: async () => () => {},
        getOrgAdminEmails: async () => [],
        getOrgName: async () => null,
        services: {} as never,
      }),
    ).resolves.toBeUndefined();
  });
});
