// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { buildPortkeyRouting } from "../../config.ts";
import type { PortkeyModelInput } from "../../../../services/portkey-router.ts";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import {
  registerModelProvider,
  resetModelProviders,
  listModelProviders,
} from "../../../../services/model-providers/registry.ts";

/**
 * Fixture providers — one per Portkey slug + apiShape combination this
 * file exercises. Registered once before all tests and torn down after,
 * since the registry is process-global (production wires it during
 * `loadModules()` boot). The preload installs core-providers, so reset
 * then re-register them after.
 */
const FIXTURE_PROVIDERS: readonly ModelProviderDefinition[] = [
  {
    providerId: "test-openai",
    displayName: "Test OpenAI",
    iconUrl: "openai",
    apiShape: "openai-completions",
    defaultBaseUrl: "https://api.openai.com/v1",
    baseUrlOverridable: false,
    authMode: "api_key",
    portkeyProvider: "openai",
    models: [],
  },
  {
    providerId: "test-openai-responses",
    displayName: "Test OpenAI Responses",
    iconUrl: "openai",
    apiShape: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    baseUrlOverridable: false,
    authMode: "api_key",
    portkeyProvider: "openai",
    models: [],
  },
  {
    providerId: "test-anthropic",
    displayName: "Test Anthropic",
    iconUrl: "anthropic",
    apiShape: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    baseUrlOverridable: false,
    authMode: "api_key",
    portkeyProvider: "anthropic",
    models: [],
  },
  {
    providerId: "test-mistral",
    displayName: "Test Mistral",
    iconUrl: "mistral",
    apiShape: "mistral-conversations",
    defaultBaseUrl: "https://api.mistral.ai",
    baseUrlOverridable: false,
    authMode: "api_key",
    portkeyProvider: "mistral-ai",
    models: [],
  },
  {
    providerId: "test-unroutable",
    displayName: "No Portkey",
    iconUrl: "",
    apiShape: "openai-completions",
    defaultBaseUrl: "https://example.test",
    baseUrlOverridable: false,
    authMode: "oauth2",
    models: [],
  },
];

let restored: readonly ModelProviderDefinition[] = [];

beforeAll(() => {
  restored = listModelProviders();
  resetModelProviders();
  for (const def of FIXTURE_PROVIDERS) registerModelProvider(def);
});

afterAll(() => {
  resetModelProviders();
  for (const def of restored) registerModelProvider(def);
});

function makeModel(overrides: Partial<PortkeyModelInput> = {}): PortkeyModelInput {
  return {
    providerId: "test-openai",
    apiShape: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test-12345",
    ...overrides,
  };
}

describe("buildPortkeyRouting", () => {
  it("returns null for an unregistered providerId", () => {
    const result = buildPortkeyRouting(
      makeModel({ providerId: "not-registered" }),
      "http://pk:8787",
    );
    expect(result).toBeNull();
  });

  it("returns null when the provider has no portkeyProvider slug (OAuth bypass)", () => {
    const result = buildPortkeyRouting(
      makeModel({ providerId: "test-unroutable" }),
      "http://pk:8787",
    );
    expect(result).toBeNull();
  });

  it("maps anthropic provider to provider=anthropic", () => {
    const r = buildPortkeyRouting(
      makeModel({
        providerId: "test-anthropic",
        apiShape: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
      "http://pk:8787",
    );
    expect(r).not.toBeNull();
    const config = JSON.parse(r!.portkeyConfig);
    expect(config.provider).toBe("anthropic");
    expect(config.api_key).toBe("sk-test-12345");
    expect(config.custom_host).toBeUndefined();
  });

  it("emits custom_host when baseUrl is non-default for the Portkey slug", () => {
    const r = buildPortkeyRouting(
      makeModel({ baseUrl: "https://my-proxy.example.com/v1" }),
      "http://pk:8787",
    );
    const config = JSON.parse(r!.portkeyConfig);
    expect(config.custom_host).toBe("https://my-proxy.example.com/v1");
  });

  it("omits custom_host when baseUrl matches the Portkey slug's default", () => {
    const r = buildPortkeyRouting(
      makeModel({
        providerId: "test-openai-responses",
        apiShape: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
      "http://pk:8787",
    );
    const config = JSON.parse(r!.portkeyConfig);
    expect(config.custom_host).toBeUndefined();
  });

  it("includes retry policy with the documented status codes", () => {
    const r = buildPortkeyRouting(makeModel(), "http://pk:8787");
    const config = JSON.parse(r!.portkeyConfig);
    expect(config.retry).toEqual({
      attempts: 3,
      on_status_codes: [429, 500, 502, 503, 504],
    });
  });

  it("appends /v1 to the gateway baseUrl for OpenAI-family shapes", () => {
    const r = buildPortkeyRouting(makeModel(), "http://host.docker.internal:9001");
    expect(r!.baseUrl).toBe("http://host.docker.internal:9001/v1");
  });

  it("does not append /v1 for anthropic-messages (path already carries /v1)", () => {
    const r = buildPortkeyRouting(
      makeModel({
        providerId: "test-anthropic",
        apiShape: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      }),
      "http://host.docker.internal:9001",
    );
    expect(r!.baseUrl).toBe("http://host.docker.internal:9001");
  });

  it("does not append /v1 for mistral-conversations (SDK already carries /v1)", () => {
    // The Mistral SDK (`@mistralai/mistralai` `chat.stream`) appends
    // `/v1/chat/completions` to its `serverURL` — same convention as
    // Anthropic, NOT OpenAI. If the gateway baseUrl also carried `/v1`
    // the sidecar would forward `<gateway>/v1/v1/chat/completions` and
    // Portkey would 404. Discovered in real-key smoke (#437 follow-up).
    const r = buildPortkeyRouting(
      makeModel({
        providerId: "test-mistral",
        apiShape: "mistral-conversations",
        baseUrl: "https://api.mistral.ai",
      }),
      "http://pk:8787",
    );
    expect(r!.baseUrl).toBe("http://pk:8787");
  });

  it("strips a trailing slash on the gateway URL before appending the prefix", () => {
    const r = buildPortkeyRouting(makeModel(), "http://pk:8787/");
    expect(r!.baseUrl).toBe("http://pk:8787/v1");
  });

  it("omits cache field by default", () => {
    const r = buildPortkeyRouting(makeModel(), "http://pk:8787");
    const config = JSON.parse(r!.portkeyConfig);
    expect(config.cache).toBeUndefined();
  });

  it("emits cache { mode, max_age } when options.cache is provided", () => {
    const r = buildPortkeyRouting(makeModel(), "http://pk:8787", {
      cache: { mode: "simple", maxAge: 1800 },
    });
    const config = JSON.parse(r!.portkeyConfig);
    expect(config.cache).toEqual({ mode: "simple", max_age: 1800 });
  });

  it("supports semantic cache mode", () => {
    const r = buildPortkeyRouting(makeModel(), "http://pk:8787", {
      cache: { mode: "semantic", maxAge: 600 },
    });
    const config = JSON.parse(r!.portkeyConfig);
    expect(config.cache).toEqual({ mode: "semantic", max_age: 600 });
  });
});
