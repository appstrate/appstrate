// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-module composition contract for the runtime model-provider
 * registry. The three canonical core-providers — openai, anthropic,
 * openai-compatible — are contributed by the `core-providers` module and
 * aggregated into the runtime registry at boot. OAuth-flavoured providers
 * (workspace modules under `packages/module-*`) contribute their own
 * definitions on top via the same path; their identity / wire-shape
 * specifics are covered in each module's own unit suite.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  getModelProvider as getModelProviderConfig,
  isOAuthModelProvider,
  listModelProviders,
  registerModelProviders,
  resetModelProviders,
} from "../../../src/services/model-providers/registry.ts";
import coreProvidersModule from "../../../src/modules/core-providers/index.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

beforeAll(() => {
  resetModelProviders();
  registerModelProviders(coreProvidersModule.modelProviders?.() ?? []);
});
afterAll(() => {
  // Restore the canonical test baseline so subsequent files in the same
  // `bun test` process see a fully-seeded registry — this file scopes the
  // registry to core-providers only, which would otherwise poison
  // anything that depends on `test-oauth` / `test-oauth-hooks`.
  seedTestModelProviders();
});

const CORE_PROVIDER_IDS = [
  "anthropic",
  "cerebras",
  "google-ai",
  "groq",
  "mistral",
  "openai",
  "openai-compatible",
  "openrouter",
  "xai",
] as const;

describe("runtime registry composition", () => {
  it("exposes every canonical core-provider (all module-contributed)", () => {
    const ids = listModelProviders()
      .map((p) => p.providerId)
      .sort();
    expect(ids).toEqual([...CORE_PROVIDER_IDS].sort());
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
        /^(anthropic-messages|openai-chat|openai-completions|openai-responses|openai-codex-responses|mistral-conversations|google-generative-ai|google-vertex|azure-openai-responses|bedrock-converse-stream)$/,
      );
      expect(cfg.defaultBaseUrl.length).toBeGreaterThan(0);
      expect(typeof cfg.baseUrlOverridable).toBe("boolean");
      expect(cfg.authMode).toMatch(/^(api_key|oauth2)$/);
    }
  });

  it("core-providers contribute api-key-only definitions (no OAuth)", () => {
    for (const cfg of listModelProviders()) {
      expect(cfg.authMode).toBe("api_key");
      expect(cfg.oauth).toBeUndefined();
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
      const ids = [...cfg.featuredModels];
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("getModelProviderConfig()", () => {
  it("returns the config for every canonical core-provider id", () => {
    for (const id of CORE_PROVIDER_IDS) {
      expect(getModelProviderConfig(id)?.providerId).toBe(id);
    }
  });

  it("returns null for unknown ids", () => {
    expect(getModelProviderConfig("@unknown/provider")).toBeNull();
    expect(getModelProviderConfig("")).toBeNull();
  });
});

describe("isOAuthModelProvider()", () => {
  it("rejects core-provider api-key ids", () => {
    expect(isOAuthModelProvider("openai")).toBe(false);
    expect(isOAuthModelProvider("anthropic")).toBe(false);
    expect(isOAuthModelProvider("openai-compatible")).toBe(false);
  });

  it("rejects anything unknown", () => {
    expect(isOAuthModelProvider("@appstrate/provider-gmail")).toBe(false);
    expect(isOAuthModelProvider("@unknown/x")).toBe(false);
    expect(isOAuthModelProvider("")).toBe(false);
  });
});
