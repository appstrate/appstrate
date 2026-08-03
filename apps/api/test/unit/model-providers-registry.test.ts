// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterAll, spyOn } from "bun:test";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import { logger } from "../../src/lib/logger.ts";
import {
  getModelProvider,
  isOAuthModelProvider,
  listModelProviders,
  registerModelProvider,
  registerModelProviders,
  resetModelProviders,
} from "../../src/services/model-providers/registry.ts";
import { registerCatalog } from "../../src/services/pricing-catalog.ts";
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
      registerModelProvider(fakeDef("claude-code", { authMode: "oauth2" }));
      registerModelProvider(fakeDef("codex", { authMode: "oauth2" }));
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
   * between a mistyped model list and a model picker that silently shows
   * nothing. It resolves the selection first, which means "resolved to
   * nothing" needs one arm per selection shape — and the two selector arms
   * carry DIFFERENT severities on purpose, pinned below: a missing catalog is
   * a source-code declaration error (throws, and registration runs inside
   * `bootCritical()` so that is a process exit), while a selector matching
   * nothing in an EXISTING catalog is reachable from the weekly bot refresh of
   * `src/data/pricing/*.json` and must never be able to take the API down.
   */
  describe("catalog reference validation", () => {
    const CATALOG = "test-registry-catalog";
    registerCatalog(CATALOG, {
      "claude-opus-5": {
        label: "synthetic",
        contextWindow: 1000,
        maxTokens: 100,
        capabilities: ["text"],
        cost: { input: 0, output: 0 },
      },
    });

    it("accepts a selector that resolves against a real catalog", () => {
      registerModelProvider(
        fakeDef("selector-ok", {
          catalogProviderId: CATALOG,
          featuredModels: { catalogFamilies: ["claude-opus"], generations: 1 },
        }),
      );
      expect(getModelProvider("selector-ok")).not.toBeNull();
    });

    it("throws when a selector points at a catalog that does not exist", () => {
      expect(() =>
        registerModelProvider(
          fakeDef("selector-no-catalog", {
            catalogProviderId: "does-not-exist",
            featuredModels: { catalogFamilies: ["claude-opus"], generations: 1 },
          }),
        ),
      ).toThrow(/no such catalog is registered.*"does-not-exist"/s);
    });

    it("registers and logs, never throws, on a family that matches nothing", () => {
      // One extra `s` — but the same shape occurs when the vendor renames a
      // family under the weekly catalog refresh. Throwing would crash-loop the
      // whole API on a third party's release notes, so this arm is an alarm,
      // not a gate. The log must name the provider and the families so the
      // cause is readable without a repro.
      const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
      try {
        registerModelProvider(
          fakeDef("selector-typo", {
            catalogProviderId: CATALOG,
            featuredModels: { catalogFamilies: ["claude-opuss"], generations: 1 },
          }),
        );
        expect(getModelProvider("selector-typo")).not.toBeNull();
        const logged = errorSpy.mock.calls.some(
          ([msg, fields]) =>
            String(msg).includes("catalog selector matched nothing") &&
            (fields as { providerId?: string })?.providerId === "selector-typo" &&
            (fields as { catalogProviderId?: string })?.catalogProviderId === CATALOG &&
            (fields as { catalogFamilies?: string[] })?.catalogFamilies?.includes(
              "claude-opuss",
            ) === true,
        );
        expect(logged).toBe(true);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("still accepts a deliberately empty array with no catalog", () => {
      // openrouter (live search) and openai-compatible (Custom only) declare
      // exactly this — the arm the selector check must not swallow.
      registerModelProvider(fakeDef("no-featured", { featuredModels: [] }));
      expect(getModelProvider("no-featured")).not.toBeNull();
    });

    it("still rejects an array id that is absent from the catalog", () => {
      expect(() =>
        registerModelProvider(
          fakeDef("array-bad-id", {
            catalogProviderId: CATALOG,
            featuredModels: ["claude-opus-99"],
          }),
        ),
      ).toThrow(/is not in the test-registry-catalog catalog/);
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
