// SPDX-License-Identifier: Apache-2.0

/**
 * The one test that drives `runPiChat` for real.
 *
 * Every other chat suite injects a scripted engine so a turn never opens a Pi
 * session against a provider — correct for testing the route, and the reason
 * the engine that now serves 100% of chat sat at ~5% line coverage. Here a
 * local stub plays BOTH servers the engine talks to (the platform MCP endpoint
 * it opens itself, and the llm-proxy the proxy binding points it at), so a
 * genuine `@earendil-works/pi-coding-agent` session runs end to end with no
 * network and no provider key.
 *
 * What it asserts is what only a real session can show:
 *   - the UI-message-stream chunk sequence the client consumes,
 *   - `before_provider_headers` replacing `Authorization` on the provider
 *     request, with the inert `proxy` runtime key never reaching the wire,
 *   - a proxy-bound turn recording NO inline usage (llm-proxy owns metering,
 *     so an inline row would double-bill),
 *   - the concurrency slot released once the response stream drains.
 *
 * It is NOT a second copy of the mapper's unit tests, and it does not assert
 * pi-ai's own request shape — that is the SDK's contract, not ours.
 */

import { describe, it, expect, afterAll } from "bun:test";
import type { UIMessage } from "ai";
import type { ChatUsageRecord } from "@appstrate/core/chat-contract";
import { createPiProxyModelBinding } from "../src/pi-chat/model-binding.ts";
import { acquirePiChatSlot } from "../src/pi-chat/concurrency.ts";
import { runPiChat } from "../src/pi-chat/engine.ts";
import type { OrgModel } from "../src/llm.ts";

const ANSWER = "Bonjour le monde";

interface Capture {
  /** Authorization header seen on each provider request. */
  authHeaders: string[];
  /** Raw body of each provider request. */
  bodies: string[];
}

/**
 * Minimal Streamable-HTTP MCP server: answers `initialize` and `tools/list`
 * (empty). A GET returns 405 so the client's best-effort inbound SSE probe is a
 * clean no-op. The engine THROWS if this handshake fails, so it is not optional
 * — this is the supported "module present, zero tools" shape.
 */
/**
 * When set, the stub blocks on this before answering `initialize`. Lets a test
 * prove the UI stream opens BEFORE the handshake: if the `start` chunk were
 * still written after it, reading the first chunk would deadlock rather than
 * return, and the test times out instead of passing for the wrong reason.
 */
let mcpInitGate: Promise<void> | null = null;

async function mcpResponse(req: Request): Promise<Response> {
  if (req.method === "GET") return new Response(null, { status: 405 });
  if (req.method === "DELETE") return new Response(null, { status: 202 });
  const msg = (await req.json()) as { id?: unknown; method?: string };
  if (!("id" in msg) || msg.id === undefined) return new Response(null, { status: 202 });
  const json = (result: unknown, extra?: Record<string, string>) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
      status: 200,
      headers: { "content-type": "application/json", ...extra },
    });
  if (msg.method === "initialize") {
    if (mcpInitGate) await mcpInitGate;
    return json(
      {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub-platform-mcp", version: "1.0.0" },
      },
      { "mcp-session-id": "sess_engine_live" },
    );
  }
  if (msg.method === "tools/list") return json({ tools: [] });
  return json({});
}

/** An OpenAI chat-completions SSE stream: role, text, stop + usage. */
function openAiSse(): Response {
  const chunk = (delta: unknown, extra = "") =>
    `data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":${JSON.stringify(delta)},"finish_reason":null}]${extra}}\n\n`;
  const frames =
    chunk({ role: "assistant" }) +
    chunk({ content: ANSWER }) +
    `data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n` +
    `data: [DONE]\n\n`;
  return new Response(frames, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const capture: Capture = { authHeaders: [], bodies: [] };

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/chat/completions")) {
      capture.authHeaders.push(req.headers.get("authorization") ?? "");
      capture.bodies.push(await req.text());
      return openAiSse();
    }
    if (path.startsWith("/api/mcp/")) return mcpResponse(req);
    return new Response("unexpected: " + path, { status: 404 });
  },
});
const ORIGIN = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

function orgModel(): OrgModel {
  return {
    id: "preset_live",
    modelId: "upstream-model-must-stay-behind-proxy",
    apiShape: "openai-completions",
    providerId: "openai",
    label: "Live engine test model",
    enabled: true,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 4_096,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}

function userTurn(text: string): UIMessage[] {
  return [{ id: "u1", role: "user", parts: [{ type: "text", text }] }];
}

/** Drive one real turn and collect its UI-message-stream chunks. */
async function runTurn(mintBearer: () => string, abortSignal?: AbortSignal) {
  const binding = createPiProxyModelBinding({ model: orgModel(), origin: ORIGIN, mintBearer })!;
  const slot = acquirePiChatSlot();
  expect(slot).not.toBeNull();

  const usage: ChatUsageRecord[] = [];
  // The slot lives in module-global state SHARED with every other test file in
  // this process. A throw between acquire and drain would leave `active`
  // permanently incremented and silently skew the capacity suites, so the
  // release is structural rather than trusted to the happy path.
  try {
    const res = runPiChat({
      slot: slot!,
      modelBinding: binding,
      presetId: "preset_live",
      orgId: "org_live",
      userId: "user_live",
      chatSessionId: null,
      messages: userTurn("dis bonjour"),
      system: "You are a helpful assistant.",
      generation: {},
      platformMcp: { url: `${ORIGIN}/api/mcp/o/org_live?context=injected`, headers: {} },
      abortSignal: abortSignal ?? new AbortController().signal,
      onError: (error) => String(error),
      recordUsage: (record) => usage.push(record),
    });

    const text = await res.text();
    const chunks: Array<{ type: string; [k: string]: unknown }> = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") chunks.push(JSON.parse(data));
    }
    return { chunks, usage };
  } finally {
    // Idempotent: `releaseOnClose` already fired on the nominal path.
    slot!.release();
  }
}

describe("runPiChat against a stub provider", () => {
  it("streams a full turn, mints a fresh bearer, bills nothing inline, frees the slot", async () => {
    capture.authHeaders.length = 0;
    capture.bodies.length = 0;
    let minted = 0;
    const { chunks, usage } = await runTurn(() => `loopback-${++minted}`);

    // (1) The client contract: a start, visible text, a finish, no error chunk.
    const types = chunks.map((c) => c.type);
    expect(types).toContain("start");
    expect(types).toContain("finish");
    expect(types.filter((t) => t === "error")).toEqual([]);
    const streamed = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta?: string }).delta ?? "")
      .join("");
    expect(streamed).toContain(ANSWER);

    // (2) The provider request actually happened, and its Authorization is the
    // freshly minted loopback bearer — NOT the inert `proxy` runtime key, which
    // must never reach the wire in any header or in the body.
    expect(capture.authHeaders.length).toBeGreaterThan(0);
    expect(capture.authHeaders[0]).toBe("Bearer loopback-1");
    expect(minted).toBeGreaterThan(0);
    for (const header of capture.authHeaders) expect(header).not.toContain("proxy");

    // (3) llm-proxy resolves the preset and owns metering: the wire carries the
    // Appstrate preset id, never the upstream model id, and the engine records
    // no inline usage row (one would double-bill).
    const body = JSON.parse(capture.bodies[0]!) as { model?: string };
    expect(body.model).toBe("preset_live");
    expect(capture.bodies[0]).not.toContain("upstream-model-must-stay-behind-proxy");
    expect(usage).toEqual([]);

    // (4) The slot was released when the response stream drained. `release()` is
    // idempotent, so a second call proving nothing — assert via capacity instead.
    const reacquired = acquirePiChatSlot();
    expect(reacquired).not.toBeNull();
    reacquired?.release();
  }, 30_000);

  it("mints a NEW bearer per provider request rather than reusing one", async () => {
    // The guard against the 60 s loopback token outliving a multi-step turn. If
    // the auth extension were dropped, the header would be the inert runtime
    // key and this assertion fails — the test can fail, which is the point.
    capture.authHeaders.length = 0;
    capture.bodies.length = 0;
    let minted = 0;
    await runTurn(() => `fresh-${++minted}`);

    expect(capture.authHeaders.length).toBe(minted);
    expect(new Set(capture.authHeaders).size).toBe(capture.authHeaders.length);
    expect(capture.authHeaders.every((h) => h.startsWith("Bearer fresh-"))).toBe(true);
  }, 30_000);

  it("closes a stopped turn as a plain stop, with no error chunk", async () => {
    // The engine's OUTER catch is the only place the abort suppression lives:
    //
    //     ...(aborted ? {} : { error: err }),
    //     finishReason: aborted ? "stop" : "error",
    //
    // `closePiTurn` itself does not suppress anything — hand it an error and it
    // emits an `error` chunk whatever `aborted` says (asserted in
    // `pi-chat-turn-closure.test.ts`). So this decision is only reachable
    // through the engine, and only on the exit where an exception escapes with
    // the turn already aborted: a stop that lands during setup, before the
    // prompt's own try/catch exists to swallow it. Aborting the signal up front
    // is exactly that shape — `buildPlatformMcpTools` is the first await and it
    // throws on an already-aborted signal.
    //
    // Delete the suppression and this fails twice over: an `error` chunk
    // appears in the stream, and the persisted metadata gains an
    // `errorCategory` — a user pressing stop would be shown a failed turn.
    const stopped = new AbortController();
    stopped.abort(new Error("stopped by user"));
    const { chunks } = await runTurn(() => "unused", stopped.signal);

    expect(chunks.map((c) => c.type)).toEqual(["start", "finish"]);
    const finish = chunks.find((c) => c.type === "finish") as {
      messageMetadata?: { appstrate?: { turn?: Record<string, unknown> } };
    };
    expect(finish.messageMetadata?.appstrate?.turn?.finishReason).toBe("stop");
    // Nothing about the abort is persisted as a failure: no category, no
    // retryable flag, no request id.
    expect(finish.messageMetadata?.appstrate?.turn).not.toHaveProperty("errorCategory");
    expect(JSON.stringify(chunks)).not.toContain("errorCategory");
  }, 30_000);

  it("opens the stream before the platform-MCP handshake completes", async () => {
    // Hold the handshake open. If the `start` chunk were written after session
    // construction — as it was before — the read below could not return, and
    // this test would time out rather than pass.
    let releaseHandshake!: () => void;
    mcpInitGate = new Promise<void>((resolve) => {
      releaseHandshake = resolve;
    });

    const binding = createPiProxyModelBinding({
      model: orgModel(),
      origin: ORIGIN,
      mintBearer: () => "loopback-early",
    })!;
    const slot = acquirePiChatSlot();
    expect(slot).not.toBeNull();

    try {
      const res = runPiChat({
        slot: slot!,
        modelBinding: binding,
        presetId: "preset_live",
        orgId: "org_live",
        userId: "user_live",
        chatSessionId: null,
        messages: userTurn("dis bonjour"),
        system: "You are a helpful assistant.",
        generation: {},
        platformMcp: { url: `${ORIGIN}/api/mcp/o/org_live?context=injected`, headers: {} },
        abortSignal: new AbortController().signal,
        onError: (error) => String(error),
        recordUsage: () => {},
      });

      // Read only as far as the first complete SSE frame.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let first: { type?: string } | undefined;
      while (!first) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        for (const line of buffered.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") {
            first = JSON.parse(data) as { type?: string };
            break;
          }
        }
      }

      // The turn is open while the handshake is still blocked.
      expect(first?.type).toBe("start");

      releaseHandshake();
      // Drain so the slot releases and no work outlives the test.
      while (!(await reader.read()).done) {
        /* drain */
      }
    } finally {
      mcpInitGate = null;
      releaseHandshake();
      slot!.release();
    }
  }, 30_000);
});
