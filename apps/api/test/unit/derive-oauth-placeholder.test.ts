// SPDX-License-Identifier: Apache-2.0

/**
 * Unit test for the platform-side `deriveOauthPlaceholder()` helper in
 * `run-launcher/pi.ts`. The helper is provider-agnostic: it asks the
 * runtime registry for a provider's `hooks.buildApiKeyPlaceholder` and
 * falls back to the generic dash-stripping placeholder when the hook is
 * absent or returns null.
 *
 * The test registers a synthetic provider with a known placeholder shape
 * so the platform helper is exercised end-to-end without importing any
 * specific module's internals.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  _deriveKeyPlaceholderForTesting as deriveKeyPlaceholder,
  _deriveOauthPlaceholderForTesting as deriveOauthPlaceholder,
} from "../../src/services/run-launcher/pi.ts";
import { registerModelProviders } from "../../src/services/model-providers/registry.ts";
import { seedTestModelProviders } from "../helpers/model-providers.ts";
import type { ModelProviderDefinition } from "@appstrate/core/module";

const SYNTH_PROVIDER_ID = "test-placeholder-oauth";
const SYNTH_PLACEHOLDER_SENTINEL = "synthetic.placeholder.value";

const synthProvider: ModelProviderDefinition = {
  providerId: SYNTH_PROVIDER_ID,
  displayName: "Test Placeholder OAuth",
  iconUrl: "openai",
  description: "Synthetic OAuth provider with a buildApiKeyPlaceholder hook (test-only).",
  apiShape: "openai-responses",
  defaultBaseUrl: "https://example.test/v1",
  baseUrlOverridable: false,
  authMode: "oauth2",
  oauth: {
    clientId: "test-placeholder-client",
    authorizationUrl: "https://auth.example.test/authorize",
    tokenUrl: "https://auth.example.test/token",
    refreshUrl: "https://auth.example.test/token",
    scopes: ["openid"],
    pkce: "S256",
  },
  models: [{ id: "test-model", contextWindow: 8000, capabilities: ["text"] }],
  hooks: {
    /**
     * Returns a fixed synthetic placeholder when the token looks "structured"
     * (contains a dot), null otherwise — exercises both the hook-served and
     * fallback paths.
     */
    buildApiKeyPlaceholder(accessToken) {
      return accessToken.includes(".") ? SYNTH_PLACEHOLDER_SENTINEL : null;
    },
  },
};

describe("deriveOauthPlaceholder", () => {
  beforeAll(() => {
    registerModelProviders([synthProvider]);
  });
  afterAll(() => {
    // Restore the canonical test baseline so subsequent files in the
    // same `bun test` process see a fully-seeded registry — otherwise the
    // synthetic provider we added (and the empty-on-clear path that some
    // tests in this file may follow) would poison cross-file isolation.
    seedTestModelProviders();
  });

  describe("provider with buildApiKeyPlaceholder hook", () => {
    it("returns the hook's placeholder when the hook produces one", () => {
      const placeholder = deriveOauthPlaceholder("a.b.c", SYNTH_PROVIDER_ID);
      expect(placeholder).toBe(SYNTH_PLACEHOLDER_SENTINEL);
    });

    it("does not leak the original token bytes when hook serves the placeholder", () => {
      const sentinel = "SENSITIVESIGSEGMENT";
      const placeholder = deriveOauthPlaceholder(`a.b.${sentinel}`, SYNTH_PROVIDER_ID);
      expect(placeholder).not.toContain(sentinel);
    });

    it("falls back to deriveKeyPlaceholder when the hook returns null", () => {
      const placeholder = deriveOauthPlaceholder("opaque-token", SYNTH_PROVIDER_ID);
      expect(placeholder).toBe(deriveKeyPlaceholder("opaque-token"));
    });

    it("returns sk-placeholder when input is undefined", () => {
      expect(deriveOauthPlaceholder(undefined, SYNTH_PROVIDER_ID)).toBe("sk-placeholder");
    });
  });

  describe("provider without hook / unknown provider", () => {
    it("delegates to deriveKeyPlaceholder when provider isn't in the registry", () => {
      const token = "sk-some-oauth-DEADBEEFCAFEBABE";
      const placeholder = deriveOauthPlaceholder(token, "unregistered-provider");
      expect(placeholder).toBe(deriveKeyPlaceholder(token));
      expect(placeholder).not.toContain("DEADBEEFCAFEBABE");
    });
  });
});
