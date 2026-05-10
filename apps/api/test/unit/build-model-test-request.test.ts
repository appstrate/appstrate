// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildModelTestRequest, testModelConfig } from "../../src/services/org-models.ts";

describe("buildModelTestRequest", () => {
  it("anthropic-messages: appends /v1/models, x-api-key for sk-ant- keys", () => {
    const { url, headers } = buildModelTestRequest({
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-key",
    });
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(headers["x-api-key"]).toBe("sk-ant-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  it("anthropic-messages: uses Bearer + oauth beta for sk-ant-oat keys", () => {
    const { headers } = buildModelTestRequest({
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-oat-token",
    });
    expect(headers["Authorization"]).toBe("Bearer sk-ant-oat-token");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  // Regression: https://github.com/appstrate/appstrate/issues/148
  it("mistral-conversations: appends /v1/models with Bearer auth", () => {
    const { url, headers } = buildModelTestRequest({
      api: "mistral-conversations",
      baseUrl: "https://api.mistral.ai",
      apiKey: "mistral-key",
    });
    expect(url).toBe("https://api.mistral.ai/v1/models");
    expect(headers["Authorization"]).toBe("Bearer mistral-key");
  });

  it("google-generative-ai: passes key as query param, no auth header", () => {
    const { url, headers } = buildModelTestRequest({
      api: "google-generative-ai",
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
      api: "google-vertex",
      baseUrl: "https://vertex.example.com/v1",
      apiKey: "vertex-token",
    });
    expect(url).toBe("https://vertex.example.com/v1/models");
    expect(headers["Authorization"]).toBe("Bearer vertex-token");
  });

  it("azure-openai-responses: appends /models with api-key header", () => {
    const { url, headers } = buildModelTestRequest({
      api: "azure-openai-responses",
      baseUrl: "https://acme.openai.azure.com/openai",
      apiKey: "azure-key",
    });
    expect(url).toBe("https://acme.openai.azure.com/openai/models");
    expect(headers["api-key"]).toBe("azure-key");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("openai-completions: appends /models with Bearer auth", () => {
    const { url, headers } = buildModelTestRequest({
      api: "openai-completions",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "groq-key",
    });
    expect(url).toBe("https://api.groq.com/openai/v1/models");
    expect(headers["Authorization"]).toBe("Bearer groq-key");
  });

  it("openai-responses: appends /models with Bearer auth", () => {
    const { url, headers } = buildModelTestRequest({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "openai-key",
    });
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(headers["Authorization"]).toBe("Bearer openai-key");
  });

  it("bedrock-converse-stream: appends /models with Bearer auth", () => {
    const { url, headers } = buildModelTestRequest({
      api: "bedrock-converse-stream",
      baseUrl: "https://bedrock.example.com",
      apiKey: "bedrock-key",
    });
    expect(url).toBe("https://bedrock.example.com/models");
    expect(headers["Authorization"]).toBe("Bearer bedrock-key");
  });

  it("unknown api: falls back to default branch (/models + Bearer)", () => {
    const { url, headers } = buildModelTestRequest({
      api: "some-future-api",
      baseUrl: "https://example.com/v9",
      apiKey: "k",
    });
    expect(url).toBe("https://example.com/v9/models");
    expect(headers["Authorization"]).toBe("Bearer k");
  });

  it("strips trailing slashes from baseUrl", () => {
    const { url } = buildModelTestRequest({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1///",
      apiKey: "k",
    });
    expect(url).toBe("https://api.openai.com/v1/models");
  });

  it("anthropic-messages + provider-claude-code: uses Bearer + oauth beta even without sk-ant-oat prefix", () => {
    // Claude Code OAuth tokens are JWTs, not sk-ant-oat — the provider id is the canonical signal.
    const { headers } = buildModelTestRequest({
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKey: "eyJhbGciOiJSUzI1NiJ9.fake.jwt",
      providerPackageId: "@appstrate/provider-claude-code",
    });
    expect(headers["Authorization"]).toBe("Bearer eyJhbGciOiJSUzI1NiJ9.fake.jwt");
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers["x-api-key"]).toBeUndefined();
  });
});

describe("testModelConfig", () => {
  // The Codex/Claude Code branches issue a real single-token inference
  // probe and need an outbound fetch — covered in the integration test
  // suite where we can intercept the upstream call. This unit suite only
  // covers the static request shape via buildModelTestRequest above.
  it("provider-codex without accountId: rejects with AUTH_FAILED before any fetch", async () => {
    const result = await testModelConfig({
      api: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      modelId: "gpt-5.4-mini",
      apiKey: "not-a-jwt",
      providerPackageId: "@appstrate/provider-codex",
      // intentionally no accountId — simulates a malformed token
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("AUTH_FAILED");
  });
});
