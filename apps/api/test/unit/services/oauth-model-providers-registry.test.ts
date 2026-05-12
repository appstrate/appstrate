// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-module composition contract for the runtime model-provider
 * registry. The four canonical OSS providers — openai, anthropic,
 * openai-compatible, codex — are all contributed by modules and
 * aggregated into the runtime registry at boot.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import {
  getModelProvider as getModelProviderConfig,
  isOAuthModelProvider,
  listModelProviders,
  registerModelProviders,
  resetModelProviders,
} from "../../../src/services/model-providers/registry.ts";
import coreProvidersModule from "../../../src/modules/core-providers/index.ts";
import codexModule from "../../../src/modules/codex/index.ts";

beforeAll(() => {
  resetModelProviders();
  registerModelProviders(coreProvidersModule.modelProviders?.() ?? []);
  registerModelProviders(codexModule.modelProviders?.() ?? []);
});

const CANONICAL_IDS = ["openai", "anthropic", "openai-compatible", "codex"] as const;

describe("runtime registry composition", () => {
  it("exposes the four canonical OSS providers (all module-contributed)", () => {
    const ids = listModelProviders()
      .map((p) => p.providerId)
      .sort();
    expect(ids).toEqual([...CANONICAL_IDS].sort());
  });

  it("each entry's providerId matches its key in the runtime registry", () => {
    for (const cfg of listModelProviders()) {
      expect(getModelProviderConfig(cfg.providerId)?.providerId).toBe(cfg.providerId);
    }
  });

  it("each entry has the universal required fields", () => {
    for (const cfg of listModelProviders()) {
      expect(cfg.displayName.length).toBeGreaterThan(0);
      expect(cfg.iconUrl.length).toBeGreaterThan(0);
      expect(cfg.apiShape).toMatch(
        /^(anthropic-messages|openai-chat|openai-responses|openai-codex-responses)$/,
      );
      expect(cfg.defaultBaseUrl.length).toBeGreaterThan(0);
      expect(typeof cfg.baseUrlOverridable).toBe("boolean");
      expect(cfg.authMode).toMatch(/^(api_key|oauth2)$/);
    }
  });

  it("oauth field is present iff authMode === 'oauth2'", () => {
    for (const cfg of listModelProviders()) {
      if (cfg.authMode === "oauth2") {
        expect(cfg.oauth).toBeDefined();
        expect(cfg.oauth!.clientId.length).toBeGreaterThan(0);
        expect(cfg.oauth!.scopes.length).toBeGreaterThan(0);
        expect(cfg.oauth!.pkce).toBe("S256");
        expect(cfg.oauth!.authorizationUrl).toMatch(/^https:\/\//);
        expect(cfg.oauth!.tokenUrl).toMatch(/^https:\/\//);
        expect(cfg.oauth!.refreshUrl).toMatch(/^https:\/\//);
      } else {
        expect(cfg.oauth).toBeUndefined();
      }
    }
  });

  it("openai-compatible is the only entry where baseUrlOverridable is true", () => {
    const overridable = listModelProviders()
      .filter((p) => p.baseUrlOverridable)
      .map((p) => p.providerId);
    expect(overridable).toEqual(["openai-compatible"]);
  });

  it("model ids are unique within each provider", () => {
    for (const cfg of listModelProviders()) {
      const ids = cfg.models.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("getModelProviderConfig()", () => {
  it("returns the config for every canonical id", () => {
    for (const id of CANONICAL_IDS) {
      expect(getModelProviderConfig(id)?.providerId).toBe(id);
    }
  });

  it("returns null for unknown ids", () => {
    expect(getModelProviderConfig("@unknown/provider")).toBeNull();
    expect(getModelProviderConfig("")).toBeNull();
  });
});

describe("isOAuthModelProvider()", () => {
  it("accepts the canonical OAuth id (codex — the only OSS OAuth provider)", () => {
    expect(isOAuthModelProvider("codex")).toBe(true);
  });

  it("rejects api-key providers and anything unknown", () => {
    expect(isOAuthModelProvider("openai")).toBe(false);
    expect(isOAuthModelProvider("anthropic")).toBe(false);
    expect(isOAuthModelProvider("openai-compatible")).toBe(false);
    expect(isOAuthModelProvider("@appstrate/provider-gmail")).toBe(false);
    expect(isOAuthModelProvider("@unknown/x")).toBe(false);
    expect(isOAuthModelProvider("")).toBe(false);
  });
});
