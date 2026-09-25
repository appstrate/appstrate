// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import {
  getModelProvider,
  isOAuthModelProvider,
  listModelProviders,
  registerModelProvider,
  registerModelProviders,
  resetModelProviders,
} from "../../src/services/model-providers/registry.ts";
import { seedTestModelProviders } from "../helpers/model-providers.ts";

function fakeDef(
  id: string,
  overrides: Partial<ModelProviderDefinition> = {},
): ModelProviderDefinition {
  return {
    providerId: id,
    displayName: id,
    iconUrl: "openai",
    apiShape: "openai-completions",
    defaultBaseUrl: "https://api.example.com",
    baseUrlOverridable: false,
    authMode: "api_key",
    featuredModels: [],
    ...overrides,
  };
}

describe("model-providers runtime registry", () => {
  beforeEach(() => {
    resetModelProviders();
  });
  afterAll(() => {
    // Restore the canonical test baseline so subsequent files in the
    // same `bun test` process see a fully-seeded registry — this test
    // exercises the registry in isolation by emptying it, which would
    // otherwise poison cross-file isolation.
    seedTestModelProviders();
  });

  describe("registerModelProvider", () => {
    it("adds a single provider that is then resolvable", () => {
      const def = fakeDef("openai");
      registerModelProvider(def);
      expect(getModelProvider("openai")).toBe(def);
      expect(listModelProviders().map((p) => p.providerId)).toEqual(["openai"]);
    });

    it("returns null for unknown ids", () => {
      expect(getModelProvider("not-here")).toBeNull();
    });

    it("throws on any duplicate providerId (same object or not)", () => {
      const def = fakeDef("openai");
      registerModelProvider(def);
      // Same reference re-registered — still a duplicate; the boot path
      // never re-registers, so we treat any retry as a programming bug.
      expect(() => registerModelProvider(def)).toThrow(/already registered/);
    });

    it("throws when a different definition reuses an existing providerId", () => {
      registerModelProvider(fakeDef("openai", { displayName: "First" }));
      expect(() => registerModelProvider(fakeDef("openai", { displayName: "Second" }))).toThrow(
        /already registered/,
      );
    });
  });

  describe("registerModelProviders (bulk)", () => {
    it("registers an array of definitions in insertion order", () => {
      registerModelProviders([fakeDef("a"), fakeDef("b"), fakeDef("c")]);
      expect(listModelProviders().map((p) => p.providerId)).toEqual(["a", "b", "c"]);
    });

    it("fails fast on a duplicate within the same batch", () => {
      expect(() =>
        registerModelProviders([fakeDef("openai"), fakeDef("openai", { displayName: "dup" })]),
      ).toThrow(/already registered/);
    });
  });

  describe("isOAuthModelProvider", () => {
    it("returns false for unknown ids", () => {
      expect(isOAuthModelProvider("nope")).toBe(false);
    });

    it("returns false for api_key providers", () => {
      registerModelProvider(fakeDef("openai", { authMode: "api_key" }));
      expect(isOAuthModelProvider("openai")).toBe(false);
    });

    it("returns true for oauth2 providers", () => {
      registerModelProvider(
        fakeDef("oauth-test", {
          authMode: "oauth2",
          modelDiscovery: { mode: "static" },
          oauth: {
            clientId: "x",
            authorizationUrl: "https://example.com/authorize",
            tokenUrl: "https://example.com/token",
            refreshUrl: "https://example.com/token",
            scopes: ["openid"],
            pkce: "S256",
          },
        }),
      );
      expect(isOAuthModelProvider("oauth-test")).toBe(true);
    });
  });

  // Every provider runs on the single Pi engine; the only classification the
  // registry exposes for delivery is oauth-class vs API-key (`isOAuthModelProvider`).
  describe("oauth-class classification", () => {
    beforeEach(() => {
      registerModelProvider(
        fakeDef("claude-code", { authMode: "oauth2", modelDiscovery: { mode: "static" } }),
      );
      registerModelProvider(
        fakeDef("codex", { authMode: "oauth2", modelDiscovery: { mode: "static" } }),
      );
      registerModelProvider(fakeDef("openai", { authMode: "api_key" }));
    });

    it("flags oauth2 subscription providers as oauth-class", () => {
      expect(isOAuthModelProvider("claude-code")).toBe(true);
      expect(isOAuthModelProvider("codex")).toBe(true);
    });
    it("flags api-key / unknown providers as non-oauth", () => {
      expect(isOAuthModelProvider("openai")).toBe(false);
      expect(isOAuthModelProvider("not-here")).toBe(false);
    });
  });

  /**
   * The boot check (`validateCatalogReferences`) is the only thing standing
   * between a mistyped featured list and a model picker that silently shows
   * nothing: every featured id must be in the provider's offer (Pi's records
   * of its Pi provider on its `apiShape`).
   */
  describe("catalog reference validation", () => {
    const anthropicShape = {
      catalogProviderId: "anthropic",
      apiShape: "anthropic-messages",
    } as const;

    it("accepts featured ids the offer carries", () => {
      registerModelProvider(
        fakeDef("array-ok", { ...anthropicShape, featuredModels: ["claude-opus-5"] }),
      );
      expect(getModelProvider("array-ok")).not.toBeNull();
    });

    it("still accepts a deliberately empty array with no catalog", () => {
      // openrouter (live search) and openai-compatible (free-form model ids) declare
      // exactly this.
      registerModelProvider(fakeDef("no-featured", { featuredModels: [] }));
      expect(getModelProvider("no-featured")).not.toBeNull();
    });

    it("throws on a featured id outside the offer", () => {
      expect(() =>
        registerModelProvider(
          fakeDef("array-bad-id", { ...anthropicShape, featuredModels: ["claude-opus-99"] }),
        ),
      ).toThrow(/features "claude-opus-99", which is not in its offer/);
    });

    it("throws on a featured id Pi records only on another api shape", () => {
      // Pi records Grok on the Responses API only.
      expect(() =>
        registerModelProvider(
          fakeDef("xai-wrong-shape", {
            catalogProviderId: "xai",
            apiShape: "openai-completions",
            featuredModels: ["grok-4.6"],
          }),
        ),
      ).toThrow(/features "grok-4.6", which is not in its offer/);
    });

    it("throws on a featured list over a provider naming no Pi provider", () => {
      expect(() =>
        registerModelProvider(fakeDef("gateway-featured", { featuredModels: ["gpt-5.5"] })),
      ).toThrow(/not in its offer/);
    });
  });

  /**
   * A subscription (oauth2) credential is a user's own token, and
   * `docs/architecture/SUBSCRIPTION_COMPLIANCE.md` allows no platform-side
   * request on one. The listing discovery path has no gate of its own, so the
   * guarantee rests on the definition declaring `mode: "static"` — which
   * registration therefore demands rather than trusts.
   */
  describe("subscription providers are never enumerated", () => {
    const oauthConfig = {
      clientId: "x",
      authorizationUrl: "https://example.com/authorize",
      tokenUrl: "https://example.com/token",
      refreshUrl: "https://example.com/token",
      scopes: ["openid"],
      pkce: "S256",
    } as const;

    it("refuses an oauth2 provider that omits modelDiscovery", () => {
      expect(() =>
        registerModelProvider(fakeDef("oauth-forgot", { authMode: "oauth2", oauth: oauthConfig })),
      ).toThrow(/must declare modelDiscovery: \{ mode: "static" \}/);
      expect(getModelProvider("oauth-forgot")).toBeNull();
    });

    it("accepts an oauth2 provider that declares mode: static", () => {
      registerModelProvider(
        fakeDef("oauth-static", {
          authMode: "oauth2",
          oauth: oauthConfig,
          modelDiscovery: { mode: "static" },
        }),
      );
      expect(getModelProvider("oauth-static")?.modelDiscovery?.mode).toBe("static");
    });

    it("leaves api_key providers free to use the listing path", () => {
      registerModelProvider(fakeDef("listing-provider", { authMode: "api_key" }));
      expect(getModelProvider("listing-provider")?.modelDiscovery).toBeUndefined();
    });
  });

  /** The inference probe speaks `openai-completions` only and needs an offered model. */
  describe("publicModelListing", () => {
    const CATALOG = "opencode-go";

    it("accepts an openai-completions provider with a featured model", () => {
      registerModelProvider(
        fakeDef("public-ok", {
          publicModelListing: true,
          catalogProviderId: CATALOG,
          featuredModels: ["kimi-k2.6"],
        }),
      );
      expect(getModelProvider("public-ok")?.publicModelListing).toBe(true);
    });

    it("refuses it on an api shape the inference probe does not speak", () => {
      expect(() =>
        registerModelProvider(
          fakeDef("public-wrong-shape", {
            apiShape: "openai-responses",
            publicModelListing: true,
            catalogProviderId: CATALOG,
            featuredModels: ["gpt-5.6-luna"],
          }),
        ),
      ).toThrow(/publicModelListing.*openai-completions/s);
      expect(getModelProvider("public-wrong-shape")).toBeNull();
    });

    it("accepts it on a provider that features nothing but has an offer (OpenRouter)", () => {
      registerModelProvider(
        fakeDef("public-offer-only", { publicModelListing: true, catalogProviderId: "openrouter" }),
      );
      expect(getModelProvider("public-offer-only")?.publicModelListing).toBe(true);
    });

    it("refuses it on a provider with no offered model to probe", () => {
      expect(() =>
        registerModelProvider(fakeDef("public-no-model", { publicModelListing: true })),
      ).toThrow(/publicModelListing.*offer/s);
    });
  });

  describe("resetModelProviders (test-only)", () => {
    it("empties the registry", () => {
      registerModelProvider(fakeDef("openai"));
      expect(listModelProviders()).toHaveLength(1);
      resetModelProviders();
      expect(listModelProviders()).toEqual([]);
    });
  });

  describe("hooks survive registration", () => {
    it("preserves the hooks reference on the stored definition", () => {
      const extractTokenIdentity = (t: string) => ({ accountId: t.slice(0, 4) });
      registerModelProvider(
        fakeDef("oauth-test", {
          authMode: "oauth2",
          modelDiscovery: { mode: "static" },
          oauth: {
            clientId: "x",
            authorizationUrl: "https://example.com/authorize",
            tokenUrl: "https://example.com/token",
            refreshUrl: "https://example.com/token",
            scopes: [],
            pkce: "S256",
          },
          hooks: { extractTokenIdentity },
        }),
      );
      const def = getModelProvider("oauth-test");
      expect(def?.hooks?.extractTokenIdentity).toBe(extractTokenIdentity);
    });
  });
});
