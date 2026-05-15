// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `resolveCatalogDefaults` — the `(providerId, modelId)` →
 * vendored-pricing-catalog lookup that feeds {@link resolveModelMetadata}.
 * Pins the `catalogProviderId` alias path (codex → openai, claude-code →
 * anthropic) and catalog-miss semantics (returns `{}`, never throws).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveCatalogDefaults } from "../../../src/services/org-models.ts";
import {
  registerModelProvider,
  resetModelProviders,
} from "../../../src/services/model-providers/registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

// `gpt-4o` ships in the vendored snapshot at $2.5 / $10 per M, 128k
// context. Asserting the canonical numbers fails loudly if a catalog
// regenerate drops the entry — better here than in production.
const GPT_4O = { contextWindow: 128_000, costInput: 2.5, costOutput: 10 };

describe("resolveCatalogDefaults", () => {
  beforeAll(() => seedTestModelProviders());
  afterAll(() => seedTestModelProviders());

  it("returns catalog entry for known (provider, model)", () => {
    const out = resolveCatalogDefaults("openai", "gpt-4o");
    expect(out.contextWindow).toBe(GPT_4O.contextWindow);
    expect(out.cost?.input).toBeCloseTo(GPT_4O.costInput, 4);
    expect(out.cost?.output).toBeCloseTo(GPT_4O.costOutput, 4);
  });

  it("returns {} on unknown model id (custom fine-tune)", () => {
    expect(resolveCatalogDefaults("openai", "ft:gpt-4o:my-org:custom:xyz")).toEqual({});
  });

  it("returns {} on unmapped provider", () => {
    expect(resolveCatalogDefaults("unmapped-provider-id", "gpt-4o")).toEqual({});
  });

  describe("catalogProviderId alias (codex → openai, claude-code → anthropic)", () => {
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
      resetModelProviders();
      seedTestModelProviders();
    });

    it("resolves catalog via catalogProviderId — wrapper's own id has no catalog file", () => {
      const out = resolveCatalogDefaults(ALIAS_ID, "gpt-4o");
      expect(out.contextWindow).toBe(GPT_4O.contextWindow);
      expect(out.cost?.input).toBeCloseTo(GPT_4O.costInput, 4);
    });
  });
});
