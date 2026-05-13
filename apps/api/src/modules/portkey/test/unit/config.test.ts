// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildPortkeyRouting, _API_SHAPE_TO_PORTKEY_PROVIDER } from "../../config.ts";
import type { ResolvedModel } from "../../../../services/org-models.ts";

function makeModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    apiShape: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-5.4",
    apiKey: "sk-test-12345",
    label: "GPT 5.4",
    isSystemModel: false,
    ...overrides,
  };
}

describe("buildPortkeyRouting", () => {
  it("returns null for unknown apiShape", () => {
    const result = buildPortkeyRouting(makeModel({ apiShape: "unknown-shape" }), "http://pk:8787");
    expect(result).toBeNull();
  });

  it("maps anthropic-messages to provider=anthropic", () => {
    const r = buildPortkeyRouting(
      makeModel({ apiShape: "anthropic-messages", baseUrl: "https://api.anthropic.com" }),
      "http://pk:8787",
    );
    expect(r).not.toBeNull();
    const config = JSON.parse(r!.portkeyConfig);
    expect(config.provider).toBe("anthropic");
    expect(config.api_key).toBe("sk-test-12345");
    expect(config.custom_host).toBeUndefined();
  });

  it("emits custom_host when baseUrl is non-default", () => {
    const r = buildPortkeyRouting(
      makeModel({ apiShape: "openai-completions", baseUrl: "https://my-proxy.example.com/v1" }),
      "http://pk:8787",
    );
    const config = JSON.parse(r!.portkeyConfig);
    expect(config.custom_host).toBe("https://my-proxy.example.com/v1");
  });

  it("omits custom_host when baseUrl matches the provider's default", () => {
    const r = buildPortkeyRouting(
      makeModel({ apiShape: "openai-responses", baseUrl: "https://api.openai.com/v1" }),
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

  it("excludes openai-codex-responses (subscription OAuth bypass)", () => {
    // The codex apiShape is the Codex/ChatGPT subscription path. It MUST NOT
    // be in the Portkey map — those calls bypass Portkey entirely.
    expect(_API_SHAPE_TO_PORTKEY_PROVIDER["openai-codex-responses"]).toBeUndefined();
  });

  it("threads the supplied sidecar URL through verbatim", () => {
    const r = buildPortkeyRouting(makeModel(), "http://host.docker.internal:9001");
    expect(r!.baseUrl).toBe("http://host.docker.internal:9001");
  });
});
