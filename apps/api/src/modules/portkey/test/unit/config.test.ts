// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildPortkeyRouting, _API_SHAPE_TO_PORTKEY_PROVIDER } from "../../config.ts";
import type { PortkeyModelInput } from "../../../../services/portkey-router.ts";

function makeModel(overrides: Partial<PortkeyModelInput> = {}): PortkeyModelInput {
  return {
    apiShape: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test-12345",
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

  it("appends /v1 to the gateway baseUrl for OpenAI-family shapes", () => {
    const r = buildPortkeyRouting(makeModel(), "http://host.docker.internal:9001");
    expect(r!.baseUrl).toBe("http://host.docker.internal:9001/v1");
  });

  it("does not append /v1 for anthropic-messages (path already carries /v1)", () => {
    const r = buildPortkeyRouting(
      makeModel({ apiShape: "anthropic-messages", baseUrl: "https://api.anthropic.com" }),
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
      makeModel({ apiShape: "mistral-conversations", baseUrl: "https://api.mistral.ai" }),
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
