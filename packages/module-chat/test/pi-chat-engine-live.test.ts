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

import { describe, it, expect, afterAll, afterEach, mock } from "bun:test";
import type { UIMessage } from "ai";
import type { ChatUsageRecord } from "@appstrate/core/chat-contract";
import { createPiProxyModelBinding } from "../src/pi-chat/model-binding.ts";
import { acquirePiChatSlot } from "../src/pi-chat/concurrency.ts";
import { runPiChat, type PiChatInput } from "../src/pi-chat/engine.ts";
import { buildPlatformMcpTools } from "../src/pi-chat/mcp-tools.ts";
import { logger } from "../src/logger.ts";
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
// Module-level, and therefore process-level: `mcpResponse` awaits it on EVERY
// subsequent handshake. Cleared in `afterEach` rather than in the one test's
// `finally`, because the failure that test guards against is a TIMEOUT — and a
// timed-out body never reaches its `finally`. A gate left pending would then
// hang every later turn in this file at 30 s apiece, burying the one real
// failure under a cascade. Harmless today only because that test happens to be
// last in the describe.
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

/**
 * When set, the provider stub PARKS the completions request instead of
 * answering it, and reports whether the client end was torn down. That is the
 * only externally visible consequence of the engine's `typedSession.abort()`:
 * a stop unblocks the engine's own await either way, so only the upstream
 * request going away distinguishes "the Pi loop was stopped" from "the Pi loop
 * is still running with nobody listening".
 *
 * Module-level and reset in `afterEach`, for the same reason `mcpInitGate` is:
 * a parked request left armed would hang every later turn in this file.
 */
let providerPark: {
  /** Called once the completions request has landed (session is constructed). */
  arrived: () => void;
  /** Resolves true if the client aborted, false if the stub gave up waiting. */
  settle: (clientAborted: boolean) => void;
} | null = null;

/** How long the parked request waits for a teardown before reporting none. */
const PARK_GIVE_UP_MS = 3_000;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("/chat/completions")) {
      capture.authHeaders.push(req.headers.get("authorization") ?? "");
      capture.bodies.push(await req.text());
      if (!providerPark) return openAiSse();
      const park = providerPark;
      park.arrived();
      return new Promise<Response>((resolve) => {
        const giveUp = setTimeout(() => {
          park.settle(false);
          resolve(openAiSse());
        }, PARK_GIVE_UP_MS);
        req.signal.addEventListener("abort", () => {
          clearTimeout(giveUp);
          park.settle(true);
          resolve(new Response(null, { status: 499 }));
        });
      });
    }
    if (path.startsWith("/api/mcp/")) return mcpResponse(req);
    return new Response("unexpected: " + path, { status: 404 });
  },
});
const ORIGIN = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));
afterEach(() => {
  mcpInitGate = null;
  providerPark = null;
});

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
async function runTurn(
  mintBearer: () => string,
  abortSignal?: AbortSignal,
  platformFetch?: typeof fetch,
) {
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
      platformMcp: {
        url: `${ORIGIN}/api/mcp/o/org_live?context=injected`,
        headers: {},
        ...(platformFetch ? { fetch: platformFetch } : {}),
      },
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

  it("tears the live Pi session down when a stop lands mid-inference", async () => {
    // The two other stop cases in this file abort during CONSTRUCTION — one up
    // front, one on a wedged MCP handshake — so neither ever reaches
    // `createAgentSession`, and `typedSession.abort()` in the engine's catch
    // was asserted nowhere. Delete it and every one of those cases still
    // passes: the client gets its start/finish envelope, the slot is released
    // on drain, and the Pi loop keeps running against the provider until the
    // turn deadline, billing tokens nobody will ever read.
    //
    // Parking the provider request is what makes that observable. The engine's
    // own await returns on abort either way (`untilAborted` races the signal),
    // so the ONLY difference the outside world can see is whether the upstream
    // request is torn down with the session.
    let arrived!: () => void;
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let settle!: (clientAborted: boolean) => void;
    const providerTornDown = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    providerPark = { arrived, settle };

    const stopped = new AbortController();
    const turn = runTurn(() => "loopback-midflight", stopped.signal);
    // Only press stop once the completions request has actually landed —
    // that is the proof the session exists and the prompt is in flight.
    await requestArrived;
    stopped.abort(new Error("stopped by user"));

    const { chunks } = await turn;
    expect(await providerTornDown).toBe(true);
    // Still a well-formed, non-error turn (same contract as the other stops).
    // The step chunks in between are whatever the model got through before the
    // stop — not pinned here, only the envelope and the absence of an error.
    const types = chunks.map((c) => c.type);
    expect(types.at(0)).toBe("start");
    expect(types.at(-1)).toBe("finish");
    expect(types).not.toContain("error");
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

  it("releases the slot when a WEDGED platform-MCP handshake is stopped", async () => {
    // The turn's whole CONSTRUCTION phase used to observe nothing: `turnAbort`
    // got its first listener only just before the prompt, ~180 lines after the
    // handshake. A platform MCP that never answers `initialize` (a DB pool
    // exhausted by concurrent runs, a module hook that never settles) therefore
    // parked `execute` forever — `createUIMessageStream` never closed,
    // `releaseOnClose` never ran, and this slot was held for the life of the
    // process. Six such turns exhaust `CHAT_PI_MAX_CONCURRENCY` and every later
    // chat 429s until restart; the user's own `POST …/stop` did nothing, since
    // it sets exactly the controller nobody was listening to.
    //
    // Own timeout, deliberately short: on the unfixed engine this does not
    // fail, it hangs (for the MCP SDK's 60 s default request timeout, which was
    // the only bound that existed).
    let releaseHandshake!: () => void;
    mcpInitGate = new Promise<void>((resolve) => {
      releaseHandshake = resolve;
    });

    const binding = createPiProxyModelBinding({
      model: orgModel(),
      origin: ORIGIN,
      mintBearer: () => "never-minted",
    })!;
    const slot = acquirePiChatSlot();
    expect(slot).not.toBeNull();
    // Counting wrapper: `release()` is idempotent and the capacity counter is
    // shared with every other suite in this process, so "a slot is available"
    // proves nothing here. Observe the call itself.
    let released = 0;
    const counted = {
      release: () => {
        released += 1;
        slot!.release();
      },
    };

    const stopped = new AbortController();
    try {
      const res = runPiChat({
        slot: counted,
        modelBinding: binding,
        presetId: "preset_live",
        orgId: "org_live",
        userId: "user_live",
        chatSessionId: null,
        messages: userTurn("dis bonjour"),
        system: "You are a helpful assistant.",
        generation: {},
        platformMcp: { url: `${ORIGIN}/api/mcp/o/org_live?context=injected`, headers: {} },
        abortSignal: stopped.signal,
        onError: (error) => String(error),
        recordUsage: () => {},
      });

      // Press stop once construction is genuinely parked on the handshake.
      const stopTimer = setTimeout(() => stopped.abort(new Error("stopped by user")), 50);
      const text = await res.text();
      clearTimeout(stopTimer);

      // The stream CLOSED — that is what `releaseOnClose` hangs off.
      expect(released).toBeGreaterThan(0);

      // And it closed as a well-formed turn, not as a bare truncation: the
      // client still needs a start/finish envelope to reconstruct a message.
      const chunks: Array<{ type: string }> = [];
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") chunks.push(JSON.parse(data) as { type: string });
      }
      expect(chunks.map((c) => c.type)).toEqual(["start", "finish"]);
    } finally {
      mcpInitGate = null;
      releaseHandshake();
      slot!.release();
    }
  }, 5_000);

  it("releases the slot when the MCP close never settles", async () => {
    // `await mcpTools?.close()` in the turn's `finally` was the last unbounded
    // await between the producer and its return: a close that never settles
    // holds `execute` open, `createUIMessageStream` never closes, and
    // `releaseOnClose` never frees the slot — the same leak the session-abort
    // bound closed, re-entered one line later. On the unbounded engine this
    // test does not fail, it HANGS: `res.text()` never resolves.
    //
    // A real close always settles, so the real builder is wrapped and only its
    // `close` replaced. The real client is closed by hand at the end so it
    // does not outlive the test.
    const binding = createPiProxyModelBinding({
      model: orgModel(),
      origin: ORIGIN,
      mintBearer: () => "loopback-close",
    })!;
    let real: Awaited<ReturnType<typeof buildPlatformMcpTools>> | undefined;
    const buildMcpTools: NonNullable<PiChatInput["buildMcpTools"]> = async (opts) => {
      real = await buildPlatformMcpTools(opts);
      return { ...real, close: () => new Promise<void>(() => {}) };
    };

    let released = 0;
    const warnSpy = mock(() => {});
    const originalWarn = logger.warn;
    logger.warn = warnSpy as unknown as typeof logger.warn;
    const startedAt = Date.now();
    try {
      const res = runPiChat({
        slot: {
          release: () => {
            released += 1;
          },
        },
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
        buildMcpTools,
      });
      const text = await res.text();

      // The body closed and the slot went with it, within the grace (5 s) plus
      // the turn's own construction — far below the 20 s this test allows.
      expect(released).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      // Said so, in the same shape as the session-abort case.
      const warned = warnSpy.mock.calls.map((c) => (c as unknown[])[0]);
      expect(warned).toContain("Pi chat MCP close did not settle — tearing the turn down anyway");
      // And the turn the client got is whole: the wedged close cost it nothing.
      const types = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter((d) => d && d !== "[DONE]")
        .map((d) => (JSON.parse(d) as { type: string }).type);
      expect(types.at(0)).toBe("start");
      expect(types.at(-1)).toBe("finish");
      expect(types).toContain("text-delta");
    } finally {
      logger.warn = originalWarn;
      await real?.close();
    }
  }, 20_000);

  it("logs the turn's construction timings once, every phase a number", async () => {
    // Where a turn's fixed cost goes is invisible without this line: the
    // handshake, the SDK import, the projection, the runtime, the loader, the
    // session, and how long the model then took to answer at all. One entry
    // per turn, keyed by session; on the happy path every phase was reached.
    const infoSpy = mock(() => {});
    const originalInfo = logger.info;
    logger.info = infoSpy as unknown as typeof logger.info;
    try {
      await runTurn(() => "loopback-timings");
    } finally {
      logger.info = originalInfo;
    }

    const lines = infoSpy.mock.calls.filter(
      (c) => (c as unknown[])[0] === "chat turn construction",
    );
    expect(lines).toHaveLength(1);
    const fields = (lines[0] as unknown[])[1] as Record<string, unknown>;
    for (const key of [
      "mcpHandshakeMs",
      "sdkLoadMs",
      "projectionMs",
      "runtimeMs",
      "loaderMs",
      "sessionMs",
      "constructionMs",
      "firstModelEventMs",
    ]) {
      expect(typeof fields[key]).toBe("number");
      expect(fields[key] as number).toBeGreaterThanOrEqual(0);
    }
    expect(fields).toHaveProperty("chatSessionId", null);
    // The model's first event comes after the prompt was issued, which comes
    // after construction — the ordering the numbers must reflect.
    expect(fields.firstModelEventMs as number).toBeGreaterThanOrEqual(
      fields.constructionMs as number,
    );
  }, 30_000);

  it("carries the caller's fetch all the way into the MCP transport", async () => {
    // The route→engine hop is asserted in `chat-stream-handler.test.ts`, which
    // probes `input.platformMcp.fetch`. The two hops AFTER it — engine →
    // `buildPlatformMcpTools`, and that → `createMcpHttpClient` — were only
    // ever evaluated on their falsy branch, because every fixture in this file
    // built `platformMcp` without a `fetch`. Deleting either conditional spread
    // left the whole suite green while production silently went back to opening
    // real loopback TCP connections per turn — and kept using them for every
    // `tools/call` after the handshake, since the override lives for the
    // client's whole lifetime.
    const seen: string[] = [];
    const recording: typeof fetch = (input, init) => {
      seen.push(new Request(input as RequestInfo, init).url);
      return fetch(input as RequestInfo, init);
    };

    const { chunks } = await runTurn(() => "bearer-mcp-fetch", undefined, recording);

    // It reached the transport: the handshake and the tool listing both went
    // through the injected fetch rather than the global one.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.includes("/api/mcp/"))).toBe(true);
    // And the turn still completed, so the injection is not merely observed —
    // it is what actually served the handshake.
    expect(chunks.at(-1)?.type).toBe("finish");
  }, 30_000);
});
