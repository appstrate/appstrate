// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { SubscriptionChatModel } from "@appstrate/core/chat-contract";
import type { AssistantMessageEventStream } from "@appstrate/runner-pi";
import type { OrgModel } from "../src/llm.ts";
import {
  createPiOAuthModelBinding,
  createPiProxyModelBinding,
  createPiProxyStream,
  resolvePiChatModelBinding,
  type PiModelStream,
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

const fakeEventStream = {} as AssistantMessageEventStream;

describe("Pi chat model binding", () => {
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
      provider: "openai",
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

  it("mints a fresh bearer for every request and preserves operational options", () => {
    const authorizations: string[] = [];
    const signals: AbortSignal[] = [];
    const timeouts: number[] = [];
    let minted = 0;
    const controller = new AbortController();
    const delegate: PiModelStream = (_model, _context, options) => {
      authorizations.push(options?.headers?.authorization ?? "");
      if (options?.signal) signals.push(options.signal);
      if (options?.timeoutMs !== undefined) timeouts.push(options.timeoutMs);
      expect(options?.headers?.["x-trace-id"]).toBe("trace-1");
      expect(options?.apiKey).toBe("proxy");
      expect(options?.maxRetries).toBe(0);
      return fakeEventStream;
    };
    const stream = createPiProxyStream({
      mintBearer: () => `bearer-${++minted}`,
      stream: delegate,
    });
    const binding = createPiProxyModelBinding({
      model: orgModel(),
      origin: ORIGIN,
      mintBearer: () => "unused",
    })!;
    const context = { messages: [] };
    const options = {
      headers: { "x-trace-id": "trace-1", authorization: "stale" },
      signal: controller.signal,
      timeoutMs: 1_234,
      maxRetries: 0,
    };

    stream(binding.model, context, options);
    stream(binding.model, context, options);

    expect(minted).toBe(2);
    expect(authorizations).toEqual(["Bearer bearer-1", "Bearer bearer-2"]);
    expect(signals).toEqual([controller.signal, controller.signal]);
    expect(timeouts).toEqual([1_234, 1_234]);
  });

  it("propagates cancellation, timeout, 401, 429 and provider failures unchanged", () => {
    const binding = createPiProxyModelBinding({
      model: orgModel(),
      origin: ORIGIN,
      mintBearer: () => "loopback",
    })!;
    const context = { messages: [] };
    const failures = [
      Object.assign(new Error("cancelled"), { name: "AbortError" }),
      Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("unauthorized"), { status: 401 }),
      Object.assign(new Error("rate limited"), { status: 429 }),
      Object.assign(new Error("provider unavailable"), { status: 503 }),
    ];

    for (const failure of failures) {
      const stream = createPiProxyStream({
        mintBearer: () => "loopback",
        stream: (() => {
          throw failure;
        }) as PiModelStream,
      });
      let caught: unknown;
      try {
        stream(binding.model, context);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
    }
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
