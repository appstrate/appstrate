// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import {
  getModelProvider,
  isOAuthModelProvider,
  listModelProviders,
  registerModelProvider,
  registerModelProviders,
  resetModelProviders,
} from "../../src/services/model-providers/registry.ts";

function fakeDef(
  id: string,
  overrides: Partial<ModelProviderDefinition> = {},
): ModelProviderDefinition {
  return {
    providerId: id,
    displayName: id,
    iconUrl: "openai",
    apiShape: "openai-chat",
    defaultBaseUrl: "https://api.example.com",
    baseUrlOverridable: false,
    authMode: "api_key",
    models: [],
    ...overrides,
  };
}

describe("model-providers runtime registry", () => {
  beforeEach(() => {
    resetModelProviders();
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
