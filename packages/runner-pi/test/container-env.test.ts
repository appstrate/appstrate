// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { buildRuntimePiEnv } from "../src/container-env.ts";

const model = {
  api: "anthropic-messages",
  modelId: "claude-sonnet-4-5",
  baseUrl: "https://api.anthropic.com",
};

describe("buildRuntimePiEnv", () => {
  it("emits the minimal required set", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "do thing" });
    expect(env.AGENT_PROMPT).toBe("do thing");
    expect(env.MODEL_API).toBe(model.api);
    expect(env.MODEL_ID).toBe(model.modelId);
    expect(env.SIDECAR_URL).toBe("http://sidecar:8080");
  });

  it("skips MODEL_BASE_URL when no proxy is configured", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "p" });
    expect(env.MODEL_BASE_URL).toBeUndefined();
    expect(env.MODEL_API_KEY).toBeUndefined();
  });

  it("routes LLM traffic through the sidecar when apiKey + proxy url are set", () => {
    const env = buildRuntimePiEnv({
      model: { ...model, apiKey: "sk-ant-secret", apiKeyPlaceholder: "sk-ant-placeholder" },
      agentPrompt: "p",
      sidecarProxyLlmUrl: "http://sidecar:8080/llm",
    });
    expect(env.MODEL_BASE_URL).toBe("http://sidecar:8080/llm");
    expect(env.MODEL_API_KEY).toBe("sk-ant-placeholder");
  });

  it("uses the raw apiKey as placeholder when none is provided", () => {
    const env = buildRuntimePiEnv({
      model: { ...model, apiKey: "sk-test" },
      agentPrompt: "p",
      sidecarProxyLlmUrl: "http://sidecar:8080/llm",
    });
    expect(env.MODEL_API_KEY).toBe("sk-test");
  });

  it("emits MODEL_INPUT / MODEL_COST / MODEL_CONTEXT_WINDOW / MODEL_MAX_TOKENS conditionally", () => {
    const env = buildRuntimePiEnv({
      model: {
        ...model,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 8192,
        reasoning: true,
        cost: { input: 3, output: 15 },
      },
      agentPrompt: "p",
    });
    expect(env.MODEL_INPUT).toBe(JSON.stringify(["text", "image"]));
    expect(env.MODEL_CONTEXT_WINDOW).toBe("200000");
    expect(env.MODEL_MAX_TOKENS).toBe("8192");
    expect(env.MODEL_REASONING).toBe("true");
    expect(env.MODEL_COST).toBe(JSON.stringify({ input: 3, output: 15 }));
  });

  it("omits MODEL_REASONING when null and emits 'false' when explicitly disabled", () => {
    const env = buildRuntimePiEnv({
      model: { ...model, reasoning: null },
      agentPrompt: "p",
    });
    expect(env.MODEL_REASONING).toBeUndefined();

    const env2 = buildRuntimePiEnv({
      model: { ...model, reasoning: false },
      agentPrompt: "p",
    });
    expect(env2.MODEL_REASONING).toBe("false");
  });

  it("joins connectedProviders, skipping the key when the list is empty", () => {
    const empty = buildRuntimePiEnv({ model, agentPrompt: "p", connectedProviders: [] });
    expect(empty.CONNECTED_PROVIDERS).toBeUndefined();

    const filled = buildRuntimePiEnv({
      model,
      agentPrompt: "p",
      connectedProviders: ["@appstrate/gmail", "@appstrate/clickup"],
    });
    expect(filled.CONNECTED_PROVIDERS).toBe("@appstrate/gmail,@appstrate/clickup");
  });

  it("serialises OUTPUT_SCHEMA when provided", () => {
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const env = buildRuntimePiEnv({ model, agentPrompt: "p", outputSchema: schema });
    expect(env.OUTPUT_SCHEMA).toBe(JSON.stringify(schema));
  });

  it("emits HTTP/HTTPS/NO proxy env vars when forward proxy is set", () => {
    const env = buildRuntimePiEnv({
      model,
      agentPrompt: "p",
      forwardProxyUrl: "http://sidecar:8081",
    });
    expect(env.HTTP_PROXY).toBe("http://sidecar:8081");
    expect(env.HTTPS_PROXY).toBe("http://sidecar:8081");
    expect(env.http_proxy).toBe("http://sidecar:8081");
    expect(env.https_proxy).toBe("http://sidecar:8081");
    expect(env.NO_PROXY).toBe("sidecar,localhost,127.0.0.1");
    expect(env.no_proxy).toBe("sidecar,localhost,127.0.0.1");
  });

  it("accepts a custom noProxy list", () => {
    const env = buildRuntimePiEnv({
      model,
      agentPrompt: "p",
      forwardProxyUrl: "http://proxy:3128",
      noProxy: "internal.corp,10.0.0.0/8",
    });
    expect(env.NO_PROXY).toBe("internal.corp,10.0.0.0/8");
  });

  it("does not emit proxy env vars when forwardProxyUrl is unset", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "p" });
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
  });

  it("forwards a W3C traceparent into TRACEPARENT when supplied", () => {
    const env = buildRuntimePiEnv({
      model,
      agentPrompt: "p",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    expect(env.TRACEPARENT).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  });

  it("does not emit TRACEPARENT when no parent trace is supplied", () => {
    const env = buildRuntimePiEnv({ model, agentPrompt: "p" });
    expect(env.TRACEPARENT).toBeUndefined();
  });
});
