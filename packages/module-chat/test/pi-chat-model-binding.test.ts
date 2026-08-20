// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { SubscriptionChatModel } from "@appstrate/core/chat-contract";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import type { OrgModel } from "../src/llm.ts";
import {
  createPiOAuthModelBinding,
  createPiProxyAuthExtension,
  createPiProxyModelBinding,
  PI_CHAT_MODEL_RUNTIME_CREATE_OPTIONS,
  resolvePiChatModelBinding,
} from "../src/pi-chat/model-binding.ts";

const ORIGIN = "http://127.0.0.1:3400";

function orgModel(overrides: Partial<OrgModel> = {}): OrgModel {
  return {
    id: "preset_chat",
    modelId: "upstream-model-must-stay-behind-proxy",
    apiShape: "openai-completions",
    providerId: "openai",
    label: "Chat model",
    enabled: true,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8_192,
    reasoning: true,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
    ...overrides,
  };
}

function oauthModel(overrides: Partial<SubscriptionChatModel> = {}): SubscriptionChatModel {
  return {
    modelId: "claude-sonnet-4-5",
    apiShape: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    accessToken: "oauth-secret-in-memory",
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 16_384,
    reasoning: true,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    ...overrides,
  };
}

describe("Pi chat model binding", () => {
  it("skips the redundant full-catalog refresh for an already resolved chat model", () => {
    expect(PI_CHAT_MODEL_RUNTIME_CREATE_OPTIONS).toEqual({
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
  });

  it("maps every API-key family to its native Pi serializer through llm-proxy", () => {
    const cases = [
      ["anthropic-messages", `${ORIGIN}/api/llm-proxy/anthropic-messages`, "anthropic"],
      ["openai-completions", `${ORIGIN}/api/llm-proxy/openai-completions/v1`, "openai"],
      ["mistral-conversations", `${ORIGIN}/api/llm-proxy/mistral-conversations`, "mistral"],
    ] as const;

    for (const [apiShape, baseUrl, provider] of cases) {
      const binding = createPiProxyModelBinding({
        model: orgModel({ apiShape }),
        origin: ORIGIN,
        mintBearer: () => "loopback",
      });
      expect(binding).toMatchObject({
        authMode: "proxy",
        provider,
        runtimeApiKey: "proxy",
        metering: { kind: "proxy" },
        model: { id: "preset_chat", api: apiShape, provider, baseUrl },
      });
      expect(JSON.stringify(binding?.model)).not.toContain("upstream-model-must-stay-behind-proxy");
      expect(JSON.stringify(binding?.model)).not.toContain("apiKey");
    }
  });

  it("adapts Anthropic and Codex subscriptions to the same binding contract", () => {
    const anthropic = createPiOAuthModelBinding(oauthModel());
    const codex = createPiOAuthModelBinding(
      oauthModel({
        modelId: "gpt-5.3-codex",
        apiShape: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
    );

    expect(anthropic).toMatchObject({
      authMode: "oauth2",
      provider: "anthropic",
      runtimeApiKey: "oauth-secret-in-memory",
      metering: { kind: "inline" },
      model: { id: "claude-sonnet-4-5", api: "anthropic-messages" },
    });
    expect(codex).toMatchObject({
      authMode: "oauth2",
      provider: "openai-codex",
      runtimeApiKey: "oauth-secret-in-memory",
      metering: { kind: "inline" },
      model: { id: "gpt-5.3-codex", api: "openai-codex-responses" },
    });
    expect(JSON.stringify(anthropic.model)).not.toContain(anthropic.runtimeApiKey);
    expect(JSON.stringify(codex.model)).not.toContain(codex.runtimeApiKey);
  });

  it("resolves auth mode before the engine branch", () => {
    const proxy = resolvePiChatModelBinding({
      model: orgModel(),
      subscription: { subscription: false },
      origin: ORIGIN,
      mintBearer: () => "loopback",
    });
    const oauth = resolvePiChatModelBinding({
      model: orgModel({ apiShape: "anthropic-messages" }),
      subscription: { subscription: true, model: oauthModel() },
      origin: ORIGIN,
      mintBearer: () => "unused",
    });
    const reconnect = resolvePiChatModelBinding({
      model: orgModel({ apiShape: "anthropic-messages" }),
      subscription: { subscription: true, needsReconnection: true },
      origin: ORIGIN,
      mintBearer: () => "unused",
    });

    expect(proxy.status === "ready" ? proxy.binding.authMode : proxy.status).toBe("proxy");
    expect(oauth.status === "ready" ? oauth.binding.authMode : oauth.status).toBe("oauth2");
    expect(reconnect).toEqual({ status: "needs-reconnection" });
  });

  it("mints a fresh bearer for every provider request", () => {
    let minted = 0;
    let handler: ((event: { headers: Record<string, string | null> }) => void) | undefined;
    const extension = createPiProxyAuthExtension(() => `bearer-${++minted}`);
    extension({
      on(event, candidate) {
        expect(event).toBe("before_provider_headers");
        handler = candidate as typeof handler;
      },
    } as ExtensionAPI);

    const first = { headers: { "x-trace-id": "trace-1", authorization: "stale" } };
    const second = { headers: { "x-trace-id": "trace-2" } };
    handler?.(first);
    handler?.(second);

    expect(minted).toBe(2);
    expect(first.headers).toEqual({
      "x-trace-id": "trace-1",
      authorization: "Bearer bearer-1",
    });
    expect(second.headers).toEqual({
      "x-trace-id": "trace-2",
      authorization: "Bearer bearer-2",
    });
  });

  it("rejects a non-proxy family instead of guessing a route", () => {
    expect(
      resolvePiChatModelBinding({
        model: orgModel({ apiShape: "openai-codex-responses" }),
        subscription: { subscription: false },
        origin: ORIGIN,
        mintBearer: () => "loopback",
      }),
    ).toEqual({ status: "unsupported" });
  });
});
