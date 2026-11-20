// SPDX-License-Identifier: Apache-2.0

/**
 * A chat turn closes with the context its NEXT request carries
 * (`appstrate.turn.context`): the last settled call's tokens over the window
 * the session ran against, never the turn's summed usage.
 *
 * The session is injected (`PiChatInput.createSession`) and replays two model
 * calls; the MCP handshake runs for real against an in-process zero-tool server.
 */

import { describe, it, expect } from "bun:test";
import type { UIMessage } from "ai";
import { createPiOAuthModelBinding } from "../src/pi-chat/model-binding.ts";
import { runPiChat } from "../src/pi-chat/engine.ts";
import type { PiChatSession } from "../src/pi-chat/turn-control.ts";
import { inertTurnSpaces } from "./turn-spaces.ts";

const MCP_URL = "http://127.0.0.1:1/api/mcp/o/org_context";

const mcpFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  if (req.method === "GET") return new Response(null, { status: 405 });
  if (req.method === "DELETE") return new Response(null, { status: 202 });
  const msg = (await req.json()) as { id?: unknown; method?: string };
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const result =
    msg.method === "initialize"
      ? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "stub-platform-mcp", version: "1.0.0" },
        }
      : msg.method === "tools/list"
        ? { tools: [] }
        : {};
  const headers = msg.method === "initialize" ? { "mcp-session-id": "sess_context" } : undefined;
  return Response.json({ jsonrpc: "2.0", id: msg.id, result }, { headers });
}) as typeof fetch;

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** `compacts`: where Pi summarized — before the first call, or after the last. */
function replaySession(usages: Usage[], compacts?: "before" | "after"): PiChatSession {
  let listener: (event: unknown) => void = () => {};
  return {
    agent: {},
    setActiveToolsByName: () => {},
    subscribe: (cb) => {
      listener = cb;
      return () => {};
    },
    prompt: async () => {
      const compaction = {
        type: "compaction_end",
        reason: "threshold",
        result: {},
        aborted: false,
      };
      if (compacts === "before") listener(compaction);
      usages.forEach((usage, i) => {
        const message = {
          role: "assistant",
          stopReason: i < usages.length - 1 ? "toolUse" : "stop",
          usage: {
            ...usage,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        listener({ type: "message_start", message });
        listener({ type: "message_end", message });
      });
      if (compacts === "after") listener(compaction);
    },
    abort: async () => {},
  };
}

/** The `finish` chunk's turn metadata, read off the SSE body. */
async function closingTurn(res: Response): Promise<Record<string, unknown> | undefined> {
  const body = await res.text();
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length);
    if (payload === "[DONE]") continue;
    const chunk = JSON.parse(payload) as {
      type?: string;
      messageMetadata?: { appstrate?: { turn?: Record<string, unknown> } };
    };
    if (chunk.type === "finish") return chunk.messageMetadata?.appstrate?.turn;
  }
  return undefined;
}

function turn(usages: Usage[], contextWindow: number | null, compacts?: "before" | "after") {
  const binding = createPiOAuthModelBinding(
    {
      modelId: "claude-sonnet-4-5",
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      accessToken: "oauth-secret-in-memory",
      credentialId: "cred-test",
      input: ["text"],
      contextWindow,
      maxTokens: 16_384,
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { pi_provider: "anthropic", pi_dialect: null },
  );
  const session = replaySession(usages, compacts);
  return runPiChat({
    slot: { release() {} },
    modelBinding: binding,
    presetId: "preset_context",
    modelLabel: "Context preset",
    orgId: "org_context",
    userId: "user_context",
    chatSessionId: null,
    messages: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "bonjour" }] },
    ] as UIMessage[],
    system: "You are a helpful assistant.",
    generation: {},
    platformMcp: { url: MCP_URL, headers: {}, organization: inertTurnSpaces(), fetch: mcpFetch },
    abortSignal: new AbortController().signal,
    onError: (error) => String(error),
    recordUsage: () => {},
    createSession: async () => ({ session }),
  });
}

describe("chat turn context", () => {
  it("closes with the last call's context over the model's window", async () => {
    const meta = await closingTurn(
      turn(
        [
          { input: 2_000, output: 500, cacheRead: 30_000, cacheWrite: 0 },
          { input: 1_000, output: 700, cacheRead: 32_500, cacheWrite: 0 },
        ],
        200_000,
      ),
    );
    expect(meta?.context).toEqual({ tokens: 34_200, window: 200_000, compactAt: 183_616 });
  }, 20_000);

  it("measures against the fallback window the session really ran on", async () => {
    const meta = await closingTurn(
      turn([{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }], null),
    );
    expect(meta?.context).toMatchObject({ tokens: 15, window: 128_000 });
  }, 20_000);

  it("flags a summary made before the first call or after the last", async () => {
    const call = [{ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }];
    for (const when of ["before", "after"] as const) {
      expect((await closingTurn(turn(call, 200_000, when)))?.context).toMatchObject({
        compacted: true,
      });
    }
    expect((await closingTurn(turn(call, 200_000)))?.context).not.toHaveProperty("compacted");
  }, 20_000);
});
