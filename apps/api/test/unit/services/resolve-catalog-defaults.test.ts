// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `resolveCatalogDefaults` — the `(providerId, modelId)` →
 * catalog lookup that feeds {@link resolveModelMetadata}. Pins the offer
 * lookup (`catalogProviderId ?? providerId` on the provider's `apiShape`),
 * unpriced models and catalog-miss semantics (returns `{}`, never throws).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolveCatalogDefaults } from "../../../src/services/org-models.ts";
import { lookupCatalogModel } from "../../../src/services/model-catalog.ts";
import {
  getModelProvider,
  registerModelProvider,
} from "../../../src/services/model-providers/registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import {
  ModelGenerationError,
  resolveModelGenerationSettings,
} from "@appstrate/core/model-generation";

describe("resolveCatalogDefaults", () => {
  beforeAll(() => seedTestModelProviders());
  afterAll(() => seedTestModelProviders());

  it("returns the catalog entry for a known (provider, model)", () => {
    const entry = lookupCatalogModel(getModelProvider("openai")!, "gpt-4o")!;
    const out = resolveCatalogDefaults("openai", "gpt-4o");
    expect(out).toMatchObject({
      label: entry.label,
      input: ["text", "image"],
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      reasoning: false,
      cost: entry.cost!,
    });
  });

  it("returns {} on a model outside the offer (custom fine-tune)", () => {
    expect(resolveCatalogDefaults("openai", "ft:gpt-4o:my-org:custom:xyz")).toEqual({});
  });

  it("returns {} on an unregistered provider", () => {
    expect(resolveCatalogDefaults("unmapped-provider-id", "gpt-4o")).toEqual({});
  });

  it("returns {} through a gateway, whatever id it serves", () => {
    expect(resolveCatalogDefaults("openai-compatible", "gpt-4o")).toEqual({});
  });

  it("carries no cost for a model the catalog leaves unpriced", () => {
    const out = resolveCatalogDefaults("mistral", "labs-devstral-small-2512");
    expect(out.contextWindow).toBeGreaterThan(0);
    expect(out).not.toHaveProperty("cost");
  });

  describe("catalogProviderId names the Pi provider", () => {
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
        apiShape: "openai-responses",
        featuredModels: [],
      });
    });
    afterAll(() => seedTestModelProviders());

    it("resolves the wrapper's model through the named Pi provider", () => {
      expect(resolveCatalogDefaults(ALIAS_ID, "gpt-4o")).toEqual(
        resolveCatalogDefaults("openai", "gpt-4o"),
      );
    });

    it("resolves the core providers whose key differs from Pi's", () => {
      expect(resolveCatalogDefaults("moonshot", "kimi-k3").label).toBeString();
      expect(
        resolveCatalogDefaults("fireworks-ai", "accounts/fireworks/models/kimi-k3").label,
      ).toBeString();
    });
  });

  describe("generation capabilities", () => {
    it("rejects temperature combined with reasoning on Anthropic Pi transports", () => {
      for (const providerId of ["anthropic", "claude-code"]) {
        const defaults = resolveCatalogDefaults(providerId, "claude-sonnet-4-5");

        expect(defaults.generation?.reasoning.temperature_compatible).toBe("unsupported");
        expect(() =>
          resolveModelGenerationSettings({
            capabilities: defaults.generation,
            override: { temperature: 0.4, reasoning_level: "low" },
          }),
        ).toThrow(ModelGenerationError);
      }
    });
  });
});
