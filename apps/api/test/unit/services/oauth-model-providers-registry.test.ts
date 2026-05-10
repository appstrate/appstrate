// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  OAUTH_MODEL_PROVIDERS,
  getOAuthModelProviderConfig,
  isOAuthModelProvider,
  listOAuthModelProviders,
} from "../../../src/services/oauth-model-providers/registry.ts";

describe("OAUTH_MODEL_PROVIDERS registry", () => {
  it("exposes both built-in providers", () => {
    expect(Object.keys(OAUTH_MODEL_PROVIDERS).sort()).toEqual([
      "@appstrate/provider-claude-code",
      "@appstrate/provider-codex",
    ]);
  });

  it("each entry's packageId matches its registry key", () => {
    for (const [key, cfg] of Object.entries(OAUTH_MODEL_PROVIDERS)) {
      expect(cfg.packageId).toBe(key);
    }
  });

  it("each entry has a non-empty client_id and scopes", () => {
    for (const cfg of listOAuthModelProviders()) {
      expect(cfg.clientId.length).toBeGreaterThan(0);
      expect(cfg.scopes.length).toBeGreaterThan(0);
      expect(cfg.pkce).toBe("S256");
    }
  });

  it("each entry has a non-empty models list with positive context windows", () => {
    for (const cfg of listOAuthModelProviders()) {
      expect(cfg.models.length).toBeGreaterThan(0);
      for (const model of cfg.models) {
        expect(model.id.length).toBeGreaterThan(0);
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.capabilities.length).toBeGreaterThan(0);
      }
    }
  });

  it("model ids are unique within each provider", () => {
    for (const cfg of listOAuthModelProviders()) {
      const ids = cfg.models.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("api.baseUrl is https for every entry", () => {
    for (const cfg of listOAuthModelProviders()) {
      expect(cfg.api.baseUrl).toMatch(/^https:\/\//);
    }
  });

  it("rewriteUrlPath has both `from` and `to` when present", () => {
    for (const cfg of listOAuthModelProviders()) {
      if (cfg.api.rewriteUrlPath) {
        expect(cfg.api.rewriteUrlPath.from.length).toBeGreaterThan(0);
        expect(cfg.api.rewriteUrlPath.to.length).toBeGreaterThan(0);
      }
    }
  });

  it("Codex entry forces stream:true, store:false, and rewrites path to /codex/responses", () => {
    const codex = OAUTH_MODEL_PROVIDERS["@appstrate/provider-codex"]!;
    expect(codex.api.apiShape).toBe("openai-responses");
    expect(codex.api.forceStream).toBe(true);
    expect(codex.api.forceStore).toBe(false);
    expect(codex.api.rewriteUrlPath).toEqual({
      from: "/v1/responses",
      to: "/codex/responses",
    });
  });

  it("Claude Code entry uses anthropic-messages shape without rewriting", () => {
    const claude = OAUTH_MODEL_PROVIDERS["@appstrate/provider-claude-code"]!;
    expect(claude.api.apiShape).toBe("anthropic-messages");
    expect(claude.api.rewriteUrlPath).toBeUndefined();
    expect(claude.api.forceStream).toBeUndefined();
  });
});

describe("getOAuthModelProviderConfig()", () => {
  it("returns the config for a registered package", () => {
    const cfg = getOAuthModelProviderConfig("@appstrate/provider-codex");
    expect(cfg).not.toBeNull();
    expect(cfg!.packageId).toBe("@appstrate/provider-codex");
  });

  it("returns null for an unknown package", () => {
    expect(getOAuthModelProviderConfig("@unknown/provider")).toBeNull();
    expect(getOAuthModelProviderConfig("")).toBeNull();
  });
});

describe("isOAuthModelProvider()", () => {
  it("accepts both built-ins", () => {
    expect(isOAuthModelProvider("@appstrate/provider-codex")).toBe(true);
    expect(isOAuthModelProvider("@appstrate/provider-claude-code")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isOAuthModelProvider("@appstrate/provider-gmail")).toBe(false);
    expect(isOAuthModelProvider("@unknown/x")).toBe(false);
    expect(isOAuthModelProvider("")).toBe(false);
  });
});
