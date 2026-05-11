// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the model-providers registry contract:
 *   - every config is well-formed (apiShape × authMode × oauth presence)
 *   - the OAuth providers (codex, claude-code) keep their stealth-mode quirks
 *     (Codex `forceStream`+path rewrite to /codex/responses, Claude Code
 *     uses plain `/v1/messages` against api.anthropic.com)
 */

import { describe, it, expect, afterEach, beforeAll } from "bun:test";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import {
  MODEL_PROVIDERS,
  getModelProviderConfig,
  isModelProviderEnabled,
  isOAuthModelProvider,
  listEnabledModelProviders,
  listModelProviders,
  seedLegacyModelProviders,
} from "../../../src/services/oauth-model-providers/registry.ts";
import {
  registerModelProviders,
  resetModelProviders,
} from "../../../src/services/model-providers/registry.ts";
import coreProvidersModule from "../../../src/modules/core-providers/index.ts";
import codexModule from "../../../src/modules/codex/index.ts";

// PR 2-5 migration: the legacy lookups now delegate to the runtime
// registry. Compose the historical set of five built-in providers by
// registering each module's contribution (core-providers: openai,
// anthropic, openai-compatible; codex: codex) and the legacy seed
// (claude-code remaining). Once claude-code is removed from OSS (PR 6),
// this suite folds into the per-module tests entirely.
beforeAll(() => {
  resetModelProviders();
  registerModelProviders(coreProvidersModule.modelProviders?.() ?? []);
  registerModelProviders(codexModule.modelProviders?.() ?? []);
  seedLegacyModelProviders();
});

const CANONICAL_IDS = ["codex", "claude-code", "openai", "anthropic", "openai-compatible"] as const;
const OAUTH_IDS = ["codex", "claude-code"] as const;

describe("MODEL_PROVIDERS registry", () => {
  it("exposes the providers still owned by the legacy seed (claude-code)", () => {
    // PR 4 moved openai + anthropic + openai-compatible into `core-providers`.
    // PR 5 moved codex into `codex` module.
    // Only claude-code remains pending PR 6 (removal from OSS).
    expect(Object.keys(MODEL_PROVIDERS).sort()).toEqual(["claude-code"]);
  });

  it("each entry's providerId matches its registry key", () => {
    for (const [key, cfg] of Object.entries(MODEL_PROVIDERS)) {
      expect(cfg.providerId).toBe(key);
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

  it("hosted providers ship a non-empty model catalog with positive context windows", () => {
    // Both OAuth providers (codex + claude-code) ship full catalogs.
    // codex is contributed by its module; claude-code is still in the
    // legacy seed. Look up via the runtime registry so the test stays
    // agnostic to provenance.
    for (const id of OAUTH_IDS) {
      const cfg = getModelProviderConfig(id)!;
      expect(cfg).not.toBeNull();
      expect(cfg.models.length).toBeGreaterThan(0);
      for (const model of cfg.models) {
        expect(model.id.length).toBeGreaterThan(0);
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.capabilities.length).toBeGreaterThan(0);
      }
    }
  });

  it("model ids are unique within each provider", () => {
    for (const cfg of listModelProviders()) {
      const ids = cfg.models.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("Claude Code entry uses anthropic-messages shape without rewriting", () => {
    // The Codex contract is asserted in the codex module's own test
    // suite (apps/api/src/modules/codex/test/unit/codex-module.test.ts).
    // Only Claude Code remains in the legacy in-code seed.
    const claude = MODEL_PROVIDERS["claude-code"]!;
    expect(claude.apiShape).toBe("anthropic-messages");
    expect(claude.rewriteUrlPath).toBeUndefined();
    expect(claude.forceStream).toBeUndefined();
    expect(claude.defaultBaseUrl).toBe("https://api.anthropic.com");
    expect(claude.oauth!.tokenUrl).toBe("https://platform.claude.com/v1/oauth/token");
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
  it("accepts canonical OAuth ids", () => {
    expect(isOAuthModelProvider("codex")).toBe(true);
    expect(isOAuthModelProvider("claude-code")).toBe(true);
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

  it("isModelProviderEnabled returns true for every canonical id when env is empty", () => {
    delete process.env.MODEL_PROVIDERS_DISABLED;
    resetEnvCache();
    for (const id of CANONICAL_IDS) {
      expect(isModelProviderEnabled(id)).toBe(true);
    }
  });

  it("isModelProviderEnabled returns false for ids listed in the env CSV", () => {
    process.env.MODEL_PROVIDERS_DISABLED = "codex,claude-code";
    resetEnvCache();
    expect(isModelProviderEnabled("codex")).toBe(false);
    expect(isModelProviderEnabled("claude-code")).toBe(false);
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
    process.env.MODEL_PROVIDERS_DISABLED = "codex,claude-code";
    resetEnvCache();
    const ids = listEnabledModelProviders().map((p) => p.providerId);
    expect(ids).not.toContain("codex");
    expect(ids).not.toContain("claude-code");
    expect(ids).toContain("openai");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai-compatible");
  });

  it("CSV parser trims whitespace and drops empty entries", () => {
    process.env.MODEL_PROVIDERS_DISABLED = " codex , , claude-code ,";
    resetEnvCache();
    expect(isModelProviderEnabled("codex")).toBe(false);
    expect(isModelProviderEnabled("claude-code")).toBe(false);
    expect(isModelProviderEnabled("openai")).toBe(true);
  });

  it("listModelProviders stays unfiltered — runtime hot path is unaffected", () => {
    process.env.MODEL_PROVIDERS_DISABLED = "codex,claude-code";
    resetEnvCache();
    const ids = listModelProviders().map((p) => p.providerId);
    expect(ids.sort()).toEqual([...CANONICAL_IDS].sort());
  });
});
