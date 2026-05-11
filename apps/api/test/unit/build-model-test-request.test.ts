// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildModelTestRequest, testModelConfig } from "../../src/services/org-models.ts";

describe("buildModelTestRequest", () => {
  it("anthropic-messages: appends /v1/models, x-api-key for sk-ant- keys", () => {
    const { url, headers } = buildModelTestRequest({
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-key",
    });
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(headers["x-api-key"]).toBe("sk-ant-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  it("anthropic-messages: uses x-api-key for every token form (no OAuth branching)", () => {
    // The historical Bearer + oauth-2025-04-20 path was removed in PR 6
    // (Anthropic Consumer ToS forbids using OAuth subscription tokens in
    // third-party tools). All Anthropic calls route through x-api-key.
    const { headers } = buildModelTestRequest({
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-api03-token",
    });
    expect(headers["x-api-key"]).toBe("sk-ant-api03-token");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Authorization"]).toBeUndefined();
  });

  // Regression: https://github.com/appstrate/appstrate/issues/148
  it("mistral-conversations: appends /v1/models with Bearer auth", () => {
    const { url, headers } = buildModelTestRequest({
      apiShape: "mistral-conversations",
      baseUrl: "https://api.mistral.ai",
      apiKey: "mistral-key",
    });
    expect(url).toBe("https://api.mistral.ai/v1/models");
    expect(headers["Authorization"]).toBe("Bearer mistral-key");
  });

  it("google-generative-ai: passes key as query param, no auth header", () => {
    const { url, headers } = buildModelTestRequest({
      apiShape: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "google key/with+special",
    });
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?key=google%20key%2Fwith%2Bspecial",
    );
    expect(headers).toEqual({});
  });

  it("google-vertex: appends /models with Bearer auth", () => {
    const { url, headers } = buildModelTestRequest({
      apiShape: "google-vertex",
      baseUrl: "https://vertex.example.com/v1",
      apiKey: "vertex-token",
    });
    expect(url).toBe("https://vertex.example.com/v1/models");
    expect(headers["Authorization"]).toBe("Bearer vertex-token");
  });

  it("azure-openai-responses: appends /models with api-key header", () => {
    const { url, headers } = buildModelTestRequest({
      apiShape: "azure-openai-responses",
      baseUrl: "https://acme.openai.azure.com/openai",
      apiKey: "azure-key",
    });
    expect(url).toBe("https://acme.openai.azure.com/openai/models");
    expect(headers["api-key"]).toBe("azure-key");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("openai-completions: appends /models with Bearer auth", () => {
    const { url, headers } = buildModelTestRequest({
      apiShape: "openai-completions",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "groq-key",
    });
    expect(url).toBe("https://api.groq.com/openai/v1/models");
    expect(headers["Authorization"]).toBe("Bearer groq-key");
  });

  it("openai-responses: appends /models with Bearer auth", () => {
    const { url, headers } = buildModelTestRequest({
      apiShape: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "openai-key",
    });
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(headers["Authorization"]).toBe("Bearer openai-key");
  });

  it("bedrock-converse-stream: appends /models with Bearer auth", () => {
    const { url, headers } = buildModelTestRequest({
      apiShape: "bedrock-converse-stream",
      baseUrl: "https://bedrock.example.com",
      apiKey: "bedrock-key",
    });
    expect(url).toBe("https://bedrock.example.com/models");
    expect(headers["Authorization"]).toBe("Bearer bedrock-key");
  });

  it("unknown api: falls back to default branch (/models + Bearer)", () => {
    const { url, headers } = buildModelTestRequest({
      apiShape: "some-future-api",
      baseUrl: "https://example.com/v9",
      apiKey: "k",
    });
    expect(url).toBe("https://example.com/v9/models");
    expect(headers["Authorization"]).toBe("Bearer k");
  });

  it("strips trailing slashes from baseUrl", () => {
    const { url } = buildModelTestRequest({
      apiShape: "openai-responses",
      baseUrl: "https://api.openai.com/v1///",
      apiKey: "k",
    });
    expect(url).toBe("https://api.openai.com/v1/models");
  });

  it("anthropic-messages: uses x-api-key (OAuth flavour removed in PR 6 for ToS reasons)", () => {
    // PR 6 retired the Anthropic OAuth path (Authorization Bearer +
    // oauth-2025-04-20 beta). Any Anthropic call goes through the API
    // key flow now.
    const { headers } = buildModelTestRequest({
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-api03-AbCdEf",
    });
    expect(headers["x-api-key"]).toBe("sk-ant-api03-AbCdEf");
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("testModelConfig", () => {
  // The Codex branch issues a real single-token inference probe and
  // needs an outbound fetch — covered in the integration test suite
  // where we can intercept the upstream call. This unit suite only
  // covers the static request shape via buildModelTestRequest above.
  it("codex without accountId: rejects with AUTH_FAILED before any fetch", async () => {
    const result = await testModelConfig({
      apiShape: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.4-mini",
      apiKey: "not-a-jwt",
      providerId: "codex",
      // intentionally no accountId — simulates a malformed token
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("AUTH_FAILED");
  });
});
