// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { SubscriptionChatModel } from "@appstrate/core/chat-contract";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import { PLATFORM_MODEL_COMPAT } from "@appstrate/runner-pi/model-compat";
import { getPiModel } from "@appstrate/runner-pi/pi-model";
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
    pi_provider: "openai",
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

/** The proxy binding of `model`, under the Pi key the platform listed for it. */
function proxyBinding(model: OrgModel, piProvider: string | null) {
  return createPiProxyModelBinding({
    model: { ...model, pi_provider: piProvider },
    origin: ORIGIN,
    mintBearer: () => "loopback",
  });
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

  // Regression (#1173 fallout): the proxy binding replaces `baseUrl` with
  // llm-proxy's, one of the two inputs Pi derives a provider's request shape
  // from. With `provider` also generic (derived from the api shape), a turn on
  // a DeepSeek-backed preset went out with `role: "developer"` — a 400 there,
  // surfaced as "Le modèle a refusé la demande". The real provider key keeps
  // Pi's detection alive.
  it("keeps the backing's Pi provider key on the proxied model", () => {
    const binding = proxyBinding(
      orgModel({ providerId: "moonshot", modelId: "kimi-k2.6" }),
      "moonshotai",
    );

    expect(binding?.provider).toBe("moonshotai");
    expect(binding?.model.provider).toBe("moonshotai");
    expect(binding?.model.baseUrl).toBe(`${ORIGIN}/api/llm-proxy/openai-completions/v1`);
  });

  // OpenCode Go is unknown to Pi's provider-level detection: the dialect comes
  // from Pi's record for the upstream model, never the wire id.
  it("takes the upstream model's dialect from Pi's registry, under the preset id", () => {
    const bind = (reasoning: boolean | null) =>
      proxyBinding(
        orgModel({ providerId: "opencode-go", modelId: "deepseek-v4-flash", reasoning }),
        "opencode-go",
      )!.model;

    expect(bind(null)).toMatchObject({
      id: "preset_chat",
      provider: "opencode-go",
      reasoning: true,
      compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false },
    });
    expect(JSON.stringify(bind(null))).not.toContain("deepseek-v4-flash");
    // An explicit platform value (org override, catalog) beats the record.
    expect(bind(false).reasoning).toBe(false);
  });

  // A gateway names no Pi provider: the api shape's generic key, no record.
  it("binds a gateway model to the api shape's generic key", () => {
    const binding = proxyBinding(
      orgModel({
        providerId: "anthropic-compatible",
        apiShape: "anthropic-messages",
        modelId: "claude-fable-5",
      }),
      null,
    );
    expect(binding?.provider).toBe("anthropic");
    expect(binding?.model.compat).toEqual({ ...PLATFORM_MODEL_COMPAT });
  });

  it("maps every API-key family to its native Pi serializer through llm-proxy", () => {
    const cases = [
      ["anthropic-messages", `${ORIGIN}/api/llm-proxy/anthropic-messages`, "anthropic"],
      ["openai-completions", `${ORIGIN}/api/llm-proxy/openai-completions/v1`, "openai"],
      ["mistral-conversations", `${ORIGIN}/api/llm-proxy/mistral-conversations`, "mistral"],
    ] as const;

    for (const [apiShape, baseUrl, provider] of cases) {
      // A provider's api shape comes from its own definition.
      const binding = proxyBinding(orgModel({ apiShape, providerId: provider }), provider);
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
    const anthropic = createPiOAuthModelBinding(oauthModel(), "anthropic");
    const codex = createPiOAuthModelBinding(
      oauthModel({
        modelId: "gpt-5.3-codex",
        apiShape: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
      "openai-codex",
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

  // claude-code resolves to Pi's `anthropic` records: the record's dialect
  // applies, the platform's refusals last (no fallbacks, no long retention).
  it("gives a claude-code subscription the anthropic record's compat", () => {
    const record = getPiModel("anthropic", "claude-fable-5", "anthropic-messages")!;
    expect(record.compat).toHaveProperty("allowedFallbackModels");
    const model = createPiOAuthModelBinding(
      oauthModel({ modelId: "claude-fable-5" }),
      "anthropic",
    ).model;
    expect(model.compat).toEqual({ ...record.compat, ...PLATFORM_MODEL_COMPAT });
    expect(model.compat).toMatchObject({ forceAdaptiveThinking: true, allowedFallbackModels: [] });
    expect(model.thinkingLevelMap).toEqual(record.thinkingLevelMap);
  });

  it("gives a codex subscription the openai-codex record's compat", () => {
    const record = getPiModel("openai-codex", "gpt-5.5", "openai-codex-responses")!;
    const model = createPiOAuthModelBinding(
      oauthModel({
        modelId: "gpt-5.5",
        apiShape: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
      "openai-codex",
    ).model;
    expect(model.provider).toBe("openai-codex");
    expect(model.compat).toEqual({ ...record.compat, ...PLATFORM_MODEL_COMPAT });
  });

  it("resolves auth mode before the engine branch", () => {
    const proxy = resolvePiChatModelBinding({
      model: orgModel(),
      subscription: { subscription: false },
      origin: ORIGIN,
      mintBearer: () => "loopback",
    });
    const oauth = resolvePiChatModelBinding({
      model: orgModel({ apiShape: "anthropic-messages", pi_provider: "anthropic" }),
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

  /**
   * Billing-safety invariant, not a preference. pi-ai defaults
   * `supportsLongCacheRetention` to TRUE on a silent record and then resolves
   * retention from `options.cacheRetention` and `process.env.PI_CACHE_RETENTION`
   * — reachable by whoever configures the API deployment. Anthropic bills a 1h
   * cache write at 2x input while the cost record carries a single `cacheWrite`
   * rate, so an unset flag puts silent under-billing one env var away. Both
   * credential modes must refuse it.
   */
  it("refuses long cache retention on both credential modes", () => {
    const proxy = resolvePiChatModelBinding({
      model: orgModel(),
      subscription: { subscription: false },
      origin: ORIGIN,
      mintBearer: () => "loopback",
    });
    const oauth = resolvePiChatModelBinding({
      model: orgModel({ apiShape: "anthropic-messages", pi_provider: "anthropic" }),
      subscription: { subscription: true, model: oauthModel() },
      origin: ORIGIN,
      mintBearer: () => "unused",
    });

    expect(proxy.status).toBe("ready");
    expect(oauth.status).toBe("ready");
    expect(proxy.status === "ready" && proxy.binding.model.compat).toMatchObject({
      supportsLongCacheRetention: false,
    });
    expect(oauth.status === "ready" && oauth.binding.model.compat).toMatchObject({
      supportsLongCacheRetention: false,
    });
  });
});
