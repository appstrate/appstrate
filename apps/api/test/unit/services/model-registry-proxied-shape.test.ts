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
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

describe("initSystemModelProviderKeys — proxied api shape", () => {
  beforeEach(seedTestModelProviders);
  afterAll(() => {
    initSystemModelProviderKeys([]);
    seedTestModelProviders();
  });

  it("fails boot on a provider whose api shape the llm-proxy does not serve", () => {
    const boot = () =>
      initSystemModelProviderKeys([
        {
          id: "sys-google",
          providerId: "google-ai",
          apiKey: "sk-system-secret",
          models: [{ id: "m-google", modelId: "gemini-flash-latest" }],
        },
      ]);
    expect(boot).toThrow(/"sys-google".*"google-generative-ai".*anthropic-messages/s);
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
