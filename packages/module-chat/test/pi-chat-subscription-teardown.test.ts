// SPDX-License-Identifier: Apache-2.0

/**
 * The Pi chat turn's teardown, asserted by DRIVING it.
 *
 * Four things must be released when a turn ends, on every exit: the Pi event
 * subscription (`subscribe()` returns the detach handle — the engine used to
 * discard it and `PiChatSession` re-declared the return type as `void`, so a
 * late Pi event wrote to a closed stream writer and threw `TypeError: Invalid
 * state` from outside any try/catch), the platform MCP client, the deadline
 * timer, and — after the response body drains — the concurrency slot.
 *
 * This file used to assert all of that by reading `engine.ts` with `readFileSync`
 * and checking for string literals. That could only ever catch a rename. It could
 * not catch the `finally` NOT BEING REACHED, which is the failure that actually
 * happened: `await typedSession.abort()` on a session whose abort never settles
 * wedges `execute`, so `createUIMessageStream` never closes, `releaseOnClose`
 * never fires, and six such turns exhaust `CHAT_PI_MAX_CONCURRENCY` until the
 * process restarts. It also could not catch `unsubscribe` being undefined at
 * runtime or invoked twice, and it broke on a prettier re-wrap.
 *
 * So the session is injected instead (`PiChatInput.createSession`, whose doc
 * explains why the seam exists) and made to misbehave the way a real one cannot
 * be asked to. Everything else runs for real: the MCP handshake over an
 * in-process transport, the Pi SDK, `ModelRuntime`, the resource loader, the
 * projected history.
 */

import { describe, it, expect } from "bun:test";
import type { UIMessage } from "ai";
import { createPiProxyModelBinding } from "../src/pi-chat/model-binding.ts";
import { runPiChat, type PiChatInput } from "../src/pi-chat/engine.ts";
import type { PiChatSession } from "../src/pi-chat/turn-control.ts";
import type { OrgModel } from "../src/llm.ts";

/** Nothing listens here — every hop must go through the injected transport. */
const ORIGIN = "http://127.0.0.1:1";
const MCP_URL = `${ORIGIN}/api/mcp/o/org_teardown`;

/**
 * The engine's own bound on a session wind-down (`SESSION_ABORT_GRACE_MS`),
 * plus room for the turn's real construction. A regression here does not fail
 * an assertion — it hangs — so the budget must exceed the grace by enough that
 * a timeout means "never gave up", not "was slow".
 */
const TURN_TIMEOUT_MS = 20_000;

/**
 * One in-process transport playing the platform MCP endpoint.
 *
 * The GET is answered with a LIVE, never-ending SSE stream rather than the 405
 * the other suites use, because tearing that channel down is the only
 * externally visible consequence of `mcpTools.close()`: the Streamable-HTTP
 * client holds the inbound stream open for the session's life and aborts it
 * when the session closes. Without it, "the MCP client was closed" is not
 * observable from outside the engine at all.
 */
function mcpTransport() {
  const seen: Array<{ method: string; path: string }> = [];
  let inboundClosed = false;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ method: req.method, path: new URL(req.url).pathname });
    if (req.method === "GET") {
      req.signal.addEventListener("abort", () => {
        inboundClosed = true;
      });
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (req.method === "DELETE") return new Response(null, { status: 202 });
    const msg = (await req.json()) as { id?: unknown; method?: string };
    if (!("id" in msg) || msg.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown, extra?: Record<string, string>) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), {
        status: 200,
        headers: { "content-type": "application/json", ...extra },
      });
    if (msg.method === "initialize") {
      return reply(
        {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "stub-platform-mcp", version: "1.0.0" },
        },
        { "mcp-session-id": "sess_teardown" },
      );
    }
    if (msg.method === "tools/list") return reply({ tools: [] });
    return reply({});
  }) as typeof fetch;
  return { fetch: impl, seen, inboundClosed: () => inboundClosed };
}

function orgModel(): OrgModel {
  return {
    id: "preset_teardown",
    modelId: "upstream-model-never-called",
    apiShape: "openai-completions",
    providerId: "openai",
    label: "Teardown test model",
    enabled: true,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 4_096,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}

interface StubSession {
  /** The session handed to the engine. */
  session: PiChatSession;
  /** Resolves once the engine has asked for the session (construction done). */
  built: Promise<void>;
  /** How many times the engine released the event subscription. */
  unsubscribeCount: () => number;
  /** Whether the engine ever subscribed at all. */
  subscribed: () => boolean;
  /** Whether the engine asked the session to wind down. */
  aborted: () => boolean;
}

/**
 * A Pi session that never finishes anything.
 *
 * `prompt()` hangs (the engine's own abort race is what ends it) and `abort()`
 * settles only if `abortSettles` says so — the misbehaviour a real
 * `AgentSession` cannot be asked for, and the one the turn must survive.
 */
function stubSession(abortSettles: boolean): StubSession {
  let unsubscribes = 0;
  let didSubscribe = false;
  let didAbort = false;
  let markBuilt!: () => void;
  const built = new Promise<void>((resolve) => {
    markBuilt = resolve;
  });

  const session = {
    agent: {},
    setActiveToolsByName: () => {},
    prompt: () => new Promise<void>(() => {}),
    subscribe: () => {
      didSubscribe = true;
      // Reported on the NEXT tick so "the engine has a live session" is true
      // when the test presses stop, and the stop cannot land during setup.
      markBuilt();
      return () => {
        unsubscribes += 1;
      };
    },
    abort: () => {
      didAbort = true;
      return abortSettles ? Promise.resolve() : new Promise<void>(() => {});
    },
  } as unknown as PiChatSession;

  return {
    session,
    built,
    unsubscribeCount: () => unsubscribes,
    subscribed: () => didSubscribe,
    aborted: () => didAbort,
  };
}

/** Drive one turn against the stub session and collect what teardown released. */
async function runStubbedTurn(abortSettles: boolean) {
  const transport = mcpTransport();
  const stub = stubSession(abortSettles);
  const binding = createPiProxyModelBinding({
    model: orgModel(),
    origin: ORIGIN,
    mintBearer: () => "loopback-teardown",
  })!;

  let released = 0;
  const stop = new AbortController();

  const createSession: NonNullable<PiChatInput["createSession"]> = async () => {
    return { session: stub.session };
  };

  const res = runPiChat({
    slot: {
      release() {
        released += 1;
      },
    },
    modelBinding: binding,
    presetId: "preset_teardown",
    orgId: "org_teardown",
    userId: "user_teardown",
    chatSessionId: null,
    messages: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "dis bonjour" }] },
    ] as UIMessage[],
    system: "You are a helpful assistant.",
    generation: {},
    platformMcp: { url: MCP_URL, headers: {}, fetch: transport.fetch },
    abortSignal: stop.signal,
    onError: (error) => String(error),
    recordUsage: () => {},
    createSession,
  });

  // Press stop only once the session exists and its prompt is in flight —
  // otherwise the abort lands during construction and never reaches the branch
  // under test.
  await stub.built;
  stop.abort(new Error("stopped by user"));

  const text = await res.text();
  return { text, released: () => released, stub, transport };
}

describe("pi chat turn teardown", () => {
  it(
    "tears the turn down even when the session abort never settles",
    async () => {
      // The regression: with an unbounded `await typedSession.abort()`, this
      // `res.text()` never resolves and the test times out instead of failing —
      // the producer is wedged, so nothing below it runs.
      const { released, stub, transport } = await runStubbedTurn(false);

      expect(stub.aborted()).toBe(true);
      // (1) The subscription was taken AND released, exactly once.
      expect(stub.subscribed()).toBe(true);
      expect(stub.unsubscribeCount()).toBe(1);
      // (2) The MCP client was closed — its inbound channel was torn down.
      expect(transport.inboundClosed()).toBe(true);
      // (3) The concurrency slot was released when the body drained. Without it,
      // `CHAT_PI_MAX_CONCURRENCY` turns like this one 429 every later chat.
      expect(released()).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    "releases the same four things on a wind-down that does settle",
    async () => {
      // Control: identical turn, cooperative session. Passes before and after —
      // a failure here means the bound displaced the normal path rather than
      // adding a floor under it.
      const { released, stub, transport } = await runStubbedTurn(true);

      expect(stub.aborted()).toBe(true);
      expect(stub.unsubscribeCount()).toBe(1);
      expect(transport.inboundClosed()).toBe(true);
      expect(released()).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    "closes a stopped turn with a well-formed, non-error envelope",
    async () => {
      // Teardown must not be bought by mangling the stream the client reads: a
      // stop is a normal ending, so the turn still opens and closes and carries
      // no error chunk.
      const { text } = await runStubbedTurn(false);
      const chunks: Array<{ type: string }> = [];
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") chunks.push(JSON.parse(data));
      }
      const types = chunks.map((c) => c.type);
      expect(types.at(0)).toBe("start");
      expect(types.at(-1)).toBe("finish");
      expect(types).not.toContain("error");
    },
    TURN_TIMEOUT_MS,
  );
});
