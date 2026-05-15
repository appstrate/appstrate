// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `resolveCapabilities` — the focused 3-field cascade
 * (`explicit > catalog > null`) that feeds both the env-driven
 * (`SYSTEM_PROVIDER_KEYS`) and DB-driven (`org_models`) builders.
 * Closes appstrate#445.
 *
 * Pure-function tests — no DB, no HTTP. The catalog is the on-disk
 * LiteLLM-vendored snapshot in `apps/api/src/data/pricing/*.json` so
 * `gpt-4o` (openai) is a stable fixture, and a hand-registered
 * test provider validates the `catalogProviderId` alias path.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveCapabilities } from "../../../src/services/org-models.ts";
import {
  registerModelProvider,
  resetModelProviders,
} from "../../../src/services/model-providers/registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

// `gpt-4o` ships in the vendored snapshot at $2.5 / $10 per M, 128k
// context, 16k max tokens. Asserting the canonical numbers keeps the
// test honest against a stale catalog (a regenerate that drops the
// entry fails loudly here, not in production).
const GPT_4O = {
  contextWindow: 128_000,
  maxTokensMin: 4_096, // Sanity floor — actual is 16_384 on the current snapshot.
  costInput: 2.5,
  costOutput: 10,
};

describe("resolveCapabilities — cascade per field", () => {
  beforeAll(() => {
    // The function reads from the model-provider registry via
    // `resolveCatalogDefaults`. Seed it to the canonical test baseline
    // (core-providers + synthetic test-oauth) so `openai` resolves.
    seedTestModelProviders();
  });
  afterAll(() => {
    // Re-seed for the next file in the same `bun test` process.
    seedTestModelProviders();
  });

  describe("contextWindow", () => {
    it("returns explicit when set (ignores catalog)", () => {
      const res = resolveCapabilities("openai", "gpt-4o", {
        contextWindow: 999,
        maxTokens: null,
        cost: null,
      });
      expect(res.contextWindow).toBe(999);
    });

    it("falls through to catalog when explicit is null", () => {
      const res = resolveCapabilities("openai", "gpt-4o", {
        contextWindow: null,
        maxTokens: null,
        cost: null,
      });
      expect(res.contextWindow).toBe(GPT_4O.contextWindow);
    });

    it("returns null on catalog miss (unknown model)", () => {
      const res = resolveCapabilities("openai", "ft:gpt-4o:my-org:custom:xyz", {
        contextWindow: null,
        maxTokens: null,
        cost: null,
      });
      expect(res.contextWindow).toBeNull();
    });

    it("returns null on catalog miss (unknown provider)", () => {
      const res = resolveCapabilities("unmapped-provider-id", "gpt-4o", {
        contextWindow: null,
        maxTokens: null,
        cost: null,
      });
      expect(res.contextWindow).toBeNull();
    });
  });

  describe("maxTokens", () => {
    it("returns explicit when set (ignores catalog)", () => {
      const res = resolveCapabilities("openai", "gpt-4o", {
        contextWindow: null,
        maxTokens: 7,
        cost: null,
      });
      expect(res.maxTokens).toBe(7);
    });

    it("falls through to catalog when explicit is null", () => {
      const res = resolveCapabilities("openai", "gpt-4o", {
        contextWindow: null,
        maxTokens: null,
        cost: null,
      });
      expect(res.maxTokens).not.toBeNull();
      expect(res.maxTokens!).toBeGreaterThanOrEqual(GPT_4O.maxTokensMin);
    });

    it("returns null on catalog miss", () => {
      const res = resolveCapabilities("openai", "ft:gpt-4o:my-org:custom:xyz", {
        contextWindow: null,
        maxTokens: null,
        cost: null,
      });
      expect(res.maxTokens).toBeNull();
    });
  });

  describe("cost", () => {
    it("returns explicit when set (ignores catalog)", () => {
      const override = { input: 1.25, output: 5, cacheRead: 0, cacheWrite: 0 };
      const res = resolveCapabilities("openai", "gpt-4o", {
        contextWindow: null,
        maxTokens: null,
        cost: override,
      });
      expect(res.cost).toEqual(override);
    });

    it("falls through to catalog when explicit is null", () => {
      const res = resolveCapabilities("openai", "gpt-4o", {
        contextWindow: null,
        maxTokens: null,
        cost: null,
      });
      expect(res.cost).not.toBeNull();
      expect(res.cost!.input).toBeCloseTo(GPT_4O.costInput, 4);
      expect(res.cost!.output).toBeCloseTo(GPT_4O.costOutput, 4);
    });

    it("returns null on catalog miss", () => {
      const res = resolveCapabilities("openai", "ft:gpt-4o:my-org:custom:xyz", {
        contextWindow: null,
        maxTokens: null,
        cost: null,
      });
      expect(res.cost).toBeNull();
    });
  });

  describe("catalogProviderId alias", () => {
    // OAuth wrappers (codex → openai, claude-code → anthropic) declare
    // `catalogProviderId` so they look up pricing in the right file.
    // Hand-register a synthetic wrapper with `catalogProviderId: "openai"`
    // — depending on `module-codex` from a core unit test would couple
    // these to a module's load order.
    const ALIAS_ID = "test-openai-wrapper-445";

    beforeAll(() => {
      registerModelProvider({
        providerId: ALIAS_ID,
        displayName: "Test wrapper (alias → openai)",
        iconUrl: "",
        authMode: "api_key",
        catalogProviderId: "openai",
        defaultBaseUrl: "https://api.openai.test/v1",
        baseUrlOverridable: false,
        apiShape: "openai-completions",
        featuredModels: [],
      });
    });
    afterAll(() => {
      // Restore the canonical baseline so subsequent suites in the same
      // `bun test` process don't see a leaked synthetic registration.
      resetModelProviders();
      seedTestModelProviders();
    });

    it("resolves catalog via catalogProviderId (codex → openai pattern)", () => {
      const res = resolveCapabilities(ALIAS_ID, "gpt-4o", {
        contextWindow: null,
        maxTokens: null,
        cost: null,
      });
      // The wrapper's own providerId has no catalog file — only the alias
      // makes the lookup succeed.
      expect(res.contextWindow).toBe(GPT_4O.contextWindow);
      expect(res.cost).not.toBeNull();
      expect(res.cost!.input).toBeCloseTo(GPT_4O.costInput, 4);
    });
  });

  describe("field independence", () => {
    it("setting contextWindow explicitly does not shadow cost catalog fallback", () => {
      // Each field cascades on its own — pinning one explicit override
      // must NOT prevent the other two from reading the catalog.
      const res = resolveCapabilities("openai", "gpt-4o", {
        contextWindow: 999,
        maxTokens: null,
        cost: null,
      });
      expect(res.contextWindow).toBe(999);
      expect(res.maxTokens).not.toBeNull();
      expect(res.cost).not.toBeNull();
      expect(res.cost!.input).toBeCloseTo(GPT_4O.costInput, 4);
    });

    it("setting maxTokens explicitly does not shadow contextWindow catalog fallback", () => {
      const res = resolveCapabilities("openai", "gpt-4o", {
        contextWindow: null,
        maxTokens: 7,
        cost: null,
      });
      expect(res.maxTokens).toBe(7);
      expect(res.contextWindow).toBe(GPT_4O.contextWindow);
    });
  });
});
