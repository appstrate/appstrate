// SPDX-License-Identifier: Apache-2.0

/**
 * `/llm/*` in `platform` mode: the upstream is the platform's metered LLM
 * proxy, authenticated with the run token. The sidecar holds no vendor
 * credential, and only the inference endpoint the proxy serves is reachable.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AppDeps } from "../app.ts";
import type { LlmProxyConfig } from "../helpers.ts";
import { createTestApp } from "./helpers/authed-app.ts";

const PLATFORM = "http://127.0.0.1:3000";
const RUN_TOKEN = "run_abc.signature";

interface Captured {
  url: string;
  headers: Headers;
  body: string;
}

function capturingFetch(): { fetchFn: typeof fetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchFn = mock(async (input: string | Request, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    captured.push({ url: request.url, headers: request.headers, body: await request.text() });
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, captured };
}

function deps(llm: LlmProxyConfig, fetchFn: typeof fetch): AppDeps {
  return {
    config: { platformApiUrl: PLATFORM, runToken: RUN_TOKEN, proxyUrl: "", llm },
    cookieJar: new Map(),
    fetchFn,
    isReady: () => true,
  };
}

describe("/llm/* — platform mode", () => {
  it("forwards inference to the platform proxy with the run token, dropping the placeholder", async () => {
    const { fetchFn, captured } = capturingFetch();
    const app = createTestApp(
      deps(
        {
          authMode: "platform",
          apiShape: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
        },
        fetchFn,
      ),
    );
    const body = JSON.stringify({ model: "claude-sonnet-4-6", messages: [] });

    const res = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "sk-ant-api03-placeholder",
        "anthropic-version": "2023-06-01",
      },
      body,
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const [call] = captured;
    expect(call!.url).toBe(`${PLATFORM}/internal/llm-proxy/anthropic-messages/v1/messages`);
    expect(call!.headers.get("authorization")).toBe(`Bearer ${RUN_TOKEN}`);
    expect(call!.headers.get("x-api-key")).toBeNull();
    expect(call!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(call!.body).toBe(body);
  });

  it("uses the proxy route of the run's api shape", async () => {
    const { fetchFn, captured } = capturingFetch();
    const app = createTestApp(
      deps(
        {
          authMode: "platform",
          apiShape: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
        },
        fetchFn,
      ),
    );
    await app.request("/llm/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: "Bearer sk-placeholder" },
      body: JSON.stringify({ model: "gpt-5", messages: [] }),
    });
    expect(captured[0]!.url).toBe(
      `${PLATFORM}/internal/llm-proxy/openai-completions/v1/chat/completions`,
    );
    expect(captured[0]!.headers.get("authorization")).toBe(`Bearer ${RUN_TOKEN}`);
  });

  it("refuses every other path and method without reaching the platform", async () => {
    const { fetchFn } = capturingFetch();
    const app = createTestApp(
      deps(
        {
          authMode: "platform",
          apiShape: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
        },
        fetchFn,
      ),
    );
    for (const [method, path] of [
      ["GET", "/llm/models"],
      ["GET", "/llm/chat/completions"],
      ["POST", "/llm/embeddings"],
      ["POST", "/llm/chat/completions/extra"],
    ] as const) {
      const res = await app.request(path, { method });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses to build for a shape the platform proxy does not serve", () => {
    const { fetchFn } = capturingFetch();
    const llm: LlmProxyConfig = {
      authMode: "platform",
      apiShape: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    };
    expect(() => createTestApp(deps(llm, fetchFn))).toThrow(
      'LLM api shape "openai-codex-responses" is not served by the platform LLM proxy',
    );
  });
});

describe("/llm/messages — platform mode, aliased", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("re-originates against the platform proxy with the run token", async () => {
    const { fetchFn: platformFetch, captured } = capturingFetch();
    globalThis.fetch = platformFetch;
    const refused = mock(async () => new Response("{}")) as unknown as typeof fetch;
    const app = createTestApp(
      deps(
        {
          authMode: "platform",
          apiShape: "openai-completions",
          baseUrl: "https://api.deepseek.com/v1",
          modelSwap: {
            alias: "appstrate-medium",
            real: "deepseek-chat",
            clientApiShape: "pi-messages",
            backingApiShape: "openai-completions",
            backing: { providerId: "deepseek", reasoning: false, input: ["text"] },
          },
        },
        refused,
      ),
    );

    const res = await app.request("/llm/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "appstrate-medium",
        context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
        options: {},
      }),
    });
    await res.text();

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]!.url).toBe(
      `${PLATFORM}/internal/llm-proxy/openai-completions/v1/chat/completions`,
    );
    expect(captured[0]!.headers.get("authorization")).toBe(`Bearer ${RUN_TOKEN}`);
    expect(refused).not.toHaveBeenCalled();
  });

  it("keeps the dialect pi-ai derives from the backing's own endpoint", async () => {
    // A gateway backing (no Pi provider key): pi-ai recognises DeepSeek by its
    // base URL alone, so the Model must carry that URL while the call goes to
    // the platform proxy.
    const { fetchFn: platformFetch, captured } = capturingFetch();
    globalThis.fetch = platformFetch;
    const app = createTestApp(
      deps(
        {
          authMode: "platform",
          apiShape: "openai-completions",
          baseUrl: "https://api.deepseek.com",
          modelSwap: {
            alias: "appstrate-medium",
            real: "deepseek-chat",
            clientApiShape: "pi-messages",
            backingApiShape: "openai-completions",
            backing: { providerId: null, input: ["text"] },
          },
        },
        mock(async () => new Response("{}")) as unknown as typeof fetch,
      ),
    );

    const res = await app.request("/llm/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "appstrate-medium",
        context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
        options: { maxTokens: 128 },
      }),
    });
    await res.text();

    expect(captured[0]!.url).toBe(
      `${PLATFORM}/internal/llm-proxy/openai-completions/v1/chat/completions`,
    );
    const body = JSON.parse(captured[0]!.body) as Record<string, unknown>;
    expect(body.max_tokens).toBe(128);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });
});
