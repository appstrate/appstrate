// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import {
  getModelProvider,
  isOAuthModelProvider,
  listModelProviders,
  isModelProviderEnabled,
  listEnabledModelProviders,
  getRegisteredProviderIds,
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
      expect(getRegisteredProviderIds()).toEqual(["openai"]);
    });

    it("returns null for unknown ids", () => {
      expect(getModelProvider("not-here")).toBeNull();
    });

    it("is idempotent when called with the same definition object", () => {
      const def = fakeDef("openai");
      registerModelProvider(def);
      // Same reference — no-op, no throw
      registerModelProvider(def);
      expect(listModelProviders()).toHaveLength(1);
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
      expect(getRegisteredProviderIds()).toEqual(["a", "b", "c"]);
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
        fakeDef("codex", {
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
      expect(isOAuthModelProvider("codex")).toBe(true);
    });
  });

  describe("isModelProviderEnabled / listEnabledModelProviders", () => {
    it("returns false for unknown ids even if not in MODEL_PROVIDERS_DISABLED", () => {
      // Soft-disable semantics keep registered-but-disabled credentials
      // resolvable in the hot path; unknown ids are simply not registered.
      expect(isModelProviderEnabled("ghost")).toBe(false);
    });

    it("returns true when registered and not present in MODEL_PROVIDERS_DISABLED", () => {
      registerModelProvider(fakeDef("openai"));
      // MODEL_PROVIDERS_DISABLED defaults to empty in tests.
      expect(isModelProviderEnabled("openai")).toBe(true);
    });

    it("listEnabledModelProviders mirrors the registered list when no disables apply", () => {
      registerModelProviders([fakeDef("a"), fakeDef("b")]);
      expect(listEnabledModelProviders().map((p) => p.providerId)).toEqual(["a", "b"]);
    });
  });

  describe("resetModelProviders (test-only)", () => {
    it("empties the registry", () => {
      registerModelProvider(fakeDef("openai"));
      expect(listModelProviders()).toHaveLength(1);
      resetModelProviders();
      expect(listModelProviders()).toEqual([]);
      expect(getRegisteredProviderIds()).toEqual([]);
    });
  });

  describe("hooks survive registration", () => {
    it("preserves the hooks reference on the stored definition", () => {
      const extractTokenIdentity = (t: string) => ({ prefix: t.slice(0, 4) });
      registerModelProvider(
        fakeDef("codex", {
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
      const def = getModelProvider("codex");
      expect(def?.hooks?.extractTokenIdentity).toBe(extractTokenIdentity);
    });
  });
});
