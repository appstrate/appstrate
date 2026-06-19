// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 3 (model alias) — end-to-end through the `/llm/*` reverse proxy with a
 * `modelSwap` config. The agent sends the alias; upstream must receive the real
 * id; the agent must read back only the alias (non-stream JSON + SSE). The real
 * backing id must never reach the caller.
 */

import { describe, it, expect, mock } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import type { CredentialsResponse } from "../helpers.ts";

const SWAP = { alias: "appstrate-medium", real: "deepseek-chat" };

function makeDeps(fetchFn: typeof fetch): AppDeps {
  return {
    config: {
      platformApiUrl: "http://mock:3000",
      runToken: "tok",
      proxyUrl: "",
      llm: {
        authMode: "api_key",
        baseUrl: "https://api.deepseek.com",
        apiKey: "real-key",
        placeholder: "sk-placeholder",
        modelSwap: SWAP,
      },
    },
    fetchCredentials: mock(
      async (): Promise<CredentialsResponse> => ({
        credentials: { access_token: "x" },
        authorizedUris: [],
        allowAllUris: true,
        credentialHeaderName: "Authorization",
        credentialHeaderPrefix: "Bearer",
        credentialFieldName: "access_token",
      }),
    ),
    cookieJar: new Map(),
    fetchFn,
    isReady: () => true,
  };
}

async function readBody(init: RequestInit | undefined): Promise<string> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof ReadableStream) return await new Response(body).text();
  return String(body ?? "");
}

describe("/llm/* model-alias swap (api_key)", () => {
  it("rewrites the request model alias→real before forwarding upstream", async () => {
    let forwarded = "";
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      forwarded = await readBody(init);
      return new Response('{"model":"deepseek-chat","choices":[]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const app = createApp(makeDeps(fetchFn));
    await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium", messages: [] }),
    });

    expect(JSON.parse(forwarded).model).toBe("deepseek-chat");
  });

  it("rewrites the non-stream response model real→alias", async () => {
    const fetchFn = mock(
      async () =>
        new Response('{"id":"x","model":"deepseek-chat","choices":[]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const app = createApp(makeDeps(fetchFn));
    const res = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium", messages: [] }),
    });
    const text = await res.text();
    expect(JSON.parse(text).model).toBe("appstrate-medium");
    expect(text).not.toContain("deepseek-chat");
  });

  it("rewrites the streaming (SSE) response model real→alias in every chunk", async () => {
    const sse =
      `data: {"object":"chat.completion.chunk","model":"deepseek-chat","choices":[]}\n\n` +
      `data: {"object":"chat.completion.chunk","model":"deepseek-chat","choices":[{"delta":{"content":"hi"}}]}\n\n` +
      `data: [DONE]\n\n`;
    const fetchFn = mock(
      async () =>
        new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    ) as unknown as typeof fetch;

    const app = createApp(makeDeps(fetchFn));
    const res = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium", messages: [], stream: true }),
    });
    const text = await res.text();
    expect(text).not.toContain("deepseek-chat");
    expect(text.match(/"model":"appstrate-medium"/g)?.length).toBe(2);
    expect(text).toContain("data: [DONE]");
  });
});
