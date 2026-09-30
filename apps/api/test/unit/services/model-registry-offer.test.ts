// SPDX-License-Identifier: Apache-2.0

/**
 * `SYSTEM_PROVIDER_KEYS`: a system model on a named provider must be in that
 * provider's offer, or boot fails naming it. Gateways and live-search providers
 * serve ids Pi does not know, so they accept any.
 */

import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import {
  initSystemModelProviderKeys,
  getSystemModels,
} from "../../../src/services/model-registry.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";

const key = (providerId: string, modelId: string, extra: Record<string, unknown> = {}) => ({
  id: `sys-${providerId}`,
  providerId,
  apiKey: "sk-system-secret",
  ...extra,
  models: [{ id: `m-${providerId}`, modelId }],
});

describe("initSystemModelProviderKeys — offer check", () => {
  beforeEach(seedTestModelProviders);
  afterAll(() => {
    initSystemModelProviderKeys([]);
    seedTestModelProviders();
  });

  it("fails boot on a model outside a named provider's offer, naming provider and model", () => {
    let message = "";
    try {
      initSystemModelProviderKeys([key("openai", "gpt-retired-9")]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('"openai"');
    expect(message).toContain('"gpt-retired-9"');
    expect(message).not.toContain("sk-system-secret");
  });

  it("registers an offered model on a named provider", () => {
    initSystemModelProviderKeys([key("anthropic", "claude-opus-5")]);
    expect(getSystemModels().get("m-anthropic")?.modelId).toBe("claude-opus-5");
  });

  it("accepts any id on a live-search provider and on a user-described gateway", () => {
    initSystemModelProviderKeys([
      key("openrouter", "vendor/unknown-to-pi"),
      key("openai-compatible", "my-local-model", {
        baseUrlOverride: "https://llm.example.test/v1",
      }),
    ]);
    expect(getSystemModels().has("m-openrouter")).toBe(true);
    expect(getSystemModels().has("m-openai-compatible")).toBe(true);
  });

  it("fails boot on a UUID-shaped system model or credential id, which would shadow an org row", () => {
    const uuid = "0b9d6f0e-3a51-4c1e-9f55-2f6d8c1a7e42";
    expect(() =>
      initSystemModelProviderKeys([
        { ...key("anthropic", "claude-opus-5"), models: [{ id: uuid, modelId: "claude-opus-5" }] },
      ]),
    ).toThrow(`model id "${uuid}" is UUID-shaped`);
    expect(() =>
      initSystemModelProviderKeys([{ ...key("anthropic", "claude-opus-5"), id: uuid }]),
    ).toThrow(`model provider credential id "${uuid}" is UUID-shaped`);
  });
});
