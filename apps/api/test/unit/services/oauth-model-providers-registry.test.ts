// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-module composition contract for the runtime model-provider
 * registry. The four canonical OSS providers — openai, anthropic,
 * openai-compatible, codex — are all contributed by modules and
 * aggregated into the runtime registry at boot.
 */

import { describe, it, expect, afterEach, beforeAll } from "bun:test";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import {
  getModelProvider as getModelProviderConfig,
  isModelProviderEnabled,
  isOAuthModelProvider,
  listEnabledModelProviders,
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
  it("exposes the four canonical OSS providers (modules + legacy seed)", () => {
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

// ─── MODEL_PROVIDERS_DISABLED env filter ─────────────────────────────────────

/**
 * The env getter is cached after first call — mutating `process.env` does
 * nothing until we flush the cache. Each test sets the env, flushes, asserts,
 * then restores in `afterEach`.
 */
describe("MODEL_PROVIDERS_DISABLED filter", () => {
  const SNAPSHOT = process.env.MODEL_PROVIDERS_DISABLED;

  afterEach(() => {
    if (SNAPSHOT === undefined) delete process.env.MODEL_PROVIDERS_DISABLED;
    else process.env.MODEL_PROVIDERS_DISABLED = SNAPSHOT;
    resetEnvCache();
  });

  it("isModelProviderEnabled returns true for every registered id when env is empty", () => {
    delete process.env.MODEL_PROVIDERS_DISABLED;
    resetEnvCache();
    for (const id of CANONICAL_IDS) {
      expect(isModelProviderEnabled(id)).toBe(true);
    }
  });

  it("isModelProviderEnabled returns false for ids listed in the env CSV", () => {
    process.env.MODEL_PROVIDERS_DISABLED = "codex";
    resetEnvCache();
    expect(isModelProviderEnabled("codex")).toBe(false);
    expect(isModelProviderEnabled("openai")).toBe(true);
    expect(isModelProviderEnabled("anthropic")).toBe(true);
    expect(isModelProviderEnabled("openai-compatible")).toBe(true);
  });

  it("listEnabledModelProviders returns the full catalog when env is empty", () => {
    delete process.env.MODEL_PROVIDERS_DISABLED;
    resetEnvCache();
    const ids = listEnabledModelProviders().map((p) => p.providerId);
    expect(ids.sort()).toEqual([...CANONICAL_IDS].sort());
  });

  it("listEnabledModelProviders filters out disabled providers", () => {
    process.env.MODEL_PROVIDERS_DISABLED = "codex";
    resetEnvCache();
    const ids = listEnabledModelProviders().map((p) => p.providerId);
    expect(ids).not.toContain("codex");
    expect(ids).toContain("openai");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai-compatible");
  });

  it("CSV parser trims whitespace and drops empty entries", () => {
    process.env.MODEL_PROVIDERS_DISABLED = " codex , , openai ,";
    resetEnvCache();
    expect(isModelProviderEnabled("codex")).toBe(false);
    expect(isModelProviderEnabled("openai")).toBe(false);
    expect(isModelProviderEnabled("anthropic")).toBe(true);
  });

  it("listModelProviders stays unfiltered — runtime hot path is unaffected", () => {
    process.env.MODEL_PROVIDERS_DISABLED = "codex,openai";
    resetEnvCache();
    const ids = listModelProviders().map((p) => p.providerId);
    expect(ids.sort()).toEqual([...CANONICAL_IDS].sort());
  });
});
