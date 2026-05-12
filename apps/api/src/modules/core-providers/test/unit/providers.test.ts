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
      "cerebras",
      "google-ai",
      "groq",
      "mistral",
      "openai",
      "openai-compatible",
      "openrouter",
      "xai",
    ]);
  });

  it("every contributed provider is api_key and has no oauth block", () => {
    for (const def of coreProvidersModule.modelProviders?.() ?? []) {
      expect(def.authMode).toBe("api_key");
      expect(def.oauth).toBeUndefined();
    }
  });

  it("openai-compatible is the only baseUrl-overridable entry", () => {
    const overridable = (coreProvidersModule.modelProviders?.() ?? [])
      .filter((p) => p.baseUrlOverridable)
      .map((p) => p.providerId);
    expect(overridable).toEqual(["openai-compatible"]);
  });

  it("pins each provider to its canonical apiShape", () => {
    const byId = new Map(
      (coreProvidersModule.modelProviders?.() ?? []).map((p) => [p.providerId, p]),
    );
    expect(byId.get("openai")?.apiShape).toBe("openai-responses");
    expect(byId.get("anthropic")?.apiShape).toBe("anthropic-messages");
    expect(byId.get("openai-compatible")?.apiShape).toBe("openai-chat");
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
        databaseUrl: null,
        redisUrl: null,
        appUrl: "http://localhost:3000",
        isEmbeddedDb: true,
        applyMigrations: async () => {},
        getSendMail: async () => () => {},
        getOrgAdminEmails: async () => [],
        services: {} as never,
      }),
    ).resolves.toBeUndefined();
  });
});
