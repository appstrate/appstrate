// SPDX-License-Identifier: Apache-2.0

/**
 * `SYSTEM_PROVIDER_KEYS`: a platform-provided model is served to runs through
 * the platform's metered LLM proxy, so a key on a protocol the proxy does not
 * serve fails boot instead of leaving its runs without an inference route.
 */

import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import {
  initSystemModelProviderKeys,
  getSystemModels,
} from "../../../src/services/model-registry.ts";
import { registerModelProvider } from "../../../src/services/model-providers/registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

describe("initSystemModelProviderKeys — proxied api shape", () => {
  beforeEach(seedTestModelProviders);
  afterAll(() => {
    initSystemModelProviderKeys([]);
    seedTestModelProviders();
  });

  it("fails boot on a provider whose api shape the llm-proxy does not serve", () => {
    registerModelProvider({
      providerId: "test-codex-key",
      displayName: "Test Codex Key",
      iconUrl: "openai",
      apiShape: "openai-codex-responses",
      defaultBaseUrl: "https://codex.example.test",
      baseUrlOverridable: false,
      authMode: "api_key",
      featuredModels: [],
    });
    const boot = () =>
      initSystemModelProviderKeys([
        {
          id: "sys-codex",
          providerId: "test-codex-key",
          apiKey: "sk-system-secret",
          models: [{ id: "m-codex", modelId: "gpt-5" }],
        },
      ]);
    expect(boot).toThrow(/"sys-codex".*"openai-codex-responses".*anthropic-messages/s);
    expect(boot).not.toThrow(/sk-system-secret/);
  });

  it("registers a key on a proxied api shape", () => {
    initSystemModelProviderKeys([
      {
        id: "sys-anthropic",
        providerId: "anthropic",
        apiKey: "sk-system-secret",
        models: [{ id: "m-anthropic", modelId: "claude-opus-5" }],
      },
    ]);
    expect(getSystemModels().has("m-anthropic")).toBe(true);
  });
});
