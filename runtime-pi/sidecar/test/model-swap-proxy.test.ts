// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 3 (model alias) — end-to-end through the `/llm/*` reverse proxy with a
 * `modelSwap` config. The agent sends the alias; upstream must receive the real
 * id; the agent must read back only the alias (non-stream JSON + SSE). The real
 * backing id must never reach the caller.
 */

import { describe, it, expect, mock } from "bun:test";
import { createApp, type AppDeps } from "../app.ts";
import { parseModelSwapEnv } from "../model-swap.ts";

// `openai-completions` backing: the OpenAI SDK posts `/chat/completions`
// (the `/v1` lives in the base URL), so that is the ONE path an aliased run
// of this shape is allowed to reach — see `isAliasInferenceCall`.
const SWAP = {
  alias: "appstrate-medium",
  real: "deepseek-chat",
  apiShape: "openai-completions" as const,
};

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
    await app.request("/llm/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium", messages: [] }),
    });

    expect(JSON.parse(forwarded).model).toBe("deepseek-chat");
  });

  it("forwards an adaptive Anthropic payload for an aliased adaptive model", async () => {
    let forwarded = "";
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      forwarded = await readBody(init);
      return new Response('{"model":"claude-sonnet-4-6","content":[]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const deps = makeDeps(fetchFn);
    if (deps.config.llm?.authMode !== "api_key") throw new Error("expected api_key llm");
    deps.config.llm.modelSwap = {
      alias: "appstrate-adaptive",
      real: "claude-sonnet-4-6",
      apiShape: "anthropic-messages",
      anthropicAdaptiveReasoning: { effort: "max" },
    };

    const app = createApp(deps);
    await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "appstrate-adaptive",
        thinking: { type: "enabled", budget_tokens: 32_768, display: "summarized" },
      }),
    });

    expect(JSON.parse(forwarded)).toMatchObject({
      model: "claude-sonnet-4-6",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
    });
    expect(forwarded).not.toContain("budget_tokens");
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
    const res = await app.request("/llm/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium", messages: [] }),
    });
    const text = await res.text();
    expect(JSON.parse(text).model).toBe("appstrate-medium");
    expect(text).not.toContain("deepseek-chat");
  });

  it("replaces an upstream error body with the synthetic envelope (never forwarded)", async () => {
    // Provider 4xx names the model in free-form prose — for an alias the body
    // is never forwarded at all; the agent gets a neutral synthesized envelope.
    const fetchFn = mock(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "The model `deepseek-chat` does not exist" } }),
          { status: 404, headers: { "Content-Type": "text/plain" } },
        ),
    ) as unknown as typeof fetch;

    const app = createApp(makeDeps(fetchFn));
    const res = await app.request("/llm/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium", messages: [] }),
    });
    expect(res.status).toBe(404);
    // The synthesized body is JSON regardless of the upstream content-type.
    expect(res.headers.get("content-type")).toBe("application/json");
    const text = await res.text();
    expect(text).toContain("appstrate-medium");
    expect(text).toContain("Upstream model error");
    expect(text).not.toContain("deepseek-chat");
    expect(text).not.toContain("does not exist");
  });

  it("omits the upstream hostname from a fetch-level 502 when a swap is configured", async () => {
    const fetchFn = mock(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ConnectionRefused" });
    }) as unknown as typeof fetch;

    const app = createApp(makeDeps(fetchFn));
    const res = await app.request("/llm/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium", messages: [] }),
    });
    expect(res.status).toBe(502);
    const text = await res.text();
    // The generic error code stays useful; the hostname would name the backing.
    expect(text).toContain("ConnectionRefused");
    expect(text).not.toContain("deepseek");
  });

  it("keeps the upstream hostname in a fetch-level 502 when NO swap is configured", async () => {
    const fetchFn = mock(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ConnectionRefused" });
    }) as unknown as typeof fetch;

    const deps = makeDeps(fetchFn);
    delete (deps.config.llm as { modelSwap?: unknown }).modelSwap;
    const app = createApp(deps);
    const res = await app.request("/llm/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium", messages: [] }),
    });
    expect(res.status).toBe(502);
    const text = await res.text();
    // No alias to protect — the hostname keeps its debugging value.
    expect(text).toContain("ConnectionRefused");
    expect(text).toContain("api.deepseek.com");
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
    const res = await app.request("/llm/chat/completions", {
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

/**
 * P0 alias-surface restriction (issue #1198, Threat B). `/llm/*` used to be a
 * total passthrough — any method, any path, recomposed onto the real upstream
 * base URL with the real credential injected. For an ALIASED run that hands an
 * adversarial agent the vendor's own catalogue over `GET /v1/models`: a 2xx
 * body, so neither the error synthesis (non-2xx only) nor the `model`-field
 * rewrite ever looked at it. An aliased run now reaches exactly one endpoint.
 */
describe("/llm/* alias surface restriction", () => {
  /** Upstream that fails the test if it is ever reached. */
  function refusingFetch(): { fetchFn: typeof fetch; calls: () => number } {
    let calls = 0;
    const fetchFn = mock(async () => {
      calls += 1;
      return new Response('{"data":[{"id":"deepseek-chat"}]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetchFn, calls: () => calls };
  }

  it("proxies the protocol's own inference call through unchanged", async () => {
    let seenUrl = "";
    const fetchFn = mock(async (url: string) => {
      seenUrl = url;
      return new Response('{"model":"deepseek-chat","choices":[]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const app = createApp(makeDeps(fetchFn));
    const res = await app.request("/llm/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium", messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(seenUrl).toBe("https://api.deepseek.com/chat/completions");
  });

  it("refuses a vendor catalogue read and never reaches upstream", async () => {
    const { fetchFn, calls } = refusingFetch();
    const app = createApp(makeDeps(fetchFn));

    const res = await app.request("/llm/v1/models", { method: "GET" });

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    // The refusal is the SAME neutral envelope every other alias refusal uses —
    // a distinct shape would itself be a signal worth probing for.
    const body = JSON.parse(await res.text());
    expect(body).toMatchObject({
      type: "error",
      error: { type: "upstream_error" },
    });
    expect(body.error.message).toContain("appstrate-medium");
    expect(JSON.stringify(body)).not.toContain("deepseek");
    // Refused BEFORE the fetch, so the real credential was never spent on it.
    expect(calls()).toBe(0);
  });

  it("refuses a non-inference method on the inference path", async () => {
    const { fetchFn, calls } = refusingFetch();
    const app = createApp(makeDeps(fetchFn));

    const res = await app.request("/llm/chat/completions", { method: "GET" });

    expect(res.status).toBe(404);
    expect(calls()).toBe(0);
  });

  it("refuses a sibling endpoint of the same vendor (path is exact, not a prefix)", async () => {
    const { fetchFn, calls } = refusingFetch();
    const app = createApp(makeDeps(fetchFn));

    const res = await app.request("/llm/chat/completions/extra", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium" }),
    });

    expect(res.status).toBe(404);
    expect(calls()).toBe(0);
  });

  it("keeps the verbatim passthrough for a NON-aliased run", async () => {
    // No alias means no opacity contract: the run's whole point is reaching the
    // provider it was configured with, so the surface stays wide open.
    let seenUrl = "";
    const fetchFn = mock(async (url: string) => {
      seenUrl = url;
      return new Response('{"data":[{"id":"deepseek-chat"}]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const deps = makeDeps(fetchFn);
    delete (deps.config.llm as { modelSwap?: unknown }).modelSwap;
    const app = createApp(deps);

    const res = await app.request("/llm/v1/models", { method: "GET" });

    expect(res.status).toBe(200);
    expect(seenUrl).toBe("https://api.deepseek.com/v1/models");
    expect(await res.text()).toContain("deepseek-chat");
  });

  it("drives the allowlist from the descriptor as it arrives over PI_MODEL_SWAP_JSON", async () => {
    // Ties the boot-time boundary to the request-time enforcement: the swap the
    // sidecar actually runs on is whatever `parseModelSwapEnv` returned, so the
    // allowed path must follow the `apiShape` that crossed the env var.
    let seenUrl = "";
    const fetchFn = mock(async (url: string) => {
      seenUrl = url;
      return new Response('{"model":"deepseek-chat","choices":[]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const deps = makeDeps(fetchFn);
    if (deps.config.llm?.authMode !== "api_key") throw new Error("expected api_key llm");
    deps.config.llm.modelSwap = parseModelSwapEnv(
      JSON.stringify({
        alias: "appstrate-medium",
        real: "deepseek-chat",
        apiShape: "openai-completions",
      }),
    );
    const app = createApp(deps);

    const allowed = await app.request("/llm/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-medium", messages: [] }),
    });
    expect(allowed.status).toBe(200);
    expect(seenUrl).toBe("https://api.deepseek.com/chat/completions");
    expect(await allowed.text()).toContain("appstrate-medium");

    expect((await app.request("/llm/v1/models", { method: "GET" })).status).toBe(404);
  });

  it("allows the Anthropic inference path for an anthropic-messages alias", async () => {
    // The allowed path is per protocol family — `/v1/messages` here, NOT the
    // OpenAI `/chat/completions` the fixture's default shape would permit.
    let seenUrl = "";
    const fetchFn = mock(async (url: string) => {
      seenUrl = url;
      return new Response('{"model":"claude-sonnet-4-6","content":[]}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const deps = makeDeps(fetchFn);
    if (deps.config.llm?.authMode !== "api_key") throw new Error("expected api_key llm");
    deps.config.llm.modelSwap = {
      alias: "appstrate-opus",
      real: "claude-sonnet-4-6",
      apiShape: "anthropic-messages",
    };
    const app = createApp(deps);

    const allowed = await app.request("/llm/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-opus", messages: [] }),
    });
    expect(allowed.status).toBe(200);
    expect(seenUrl).toBe("https://api.deepseek.com/v1/messages");

    const refused = await app.request("/llm/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "appstrate-opus", messages: [] }),
    });
    expect(refused.status).toBe(404);
  });
});
